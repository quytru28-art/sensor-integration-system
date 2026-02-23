require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;
const normalizePhone = (value = '') => {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return digits;
};
const normalizeEmail = (value = '') => String(value).trim().toLowerCase();
const toClientEmail = (email) => {
  if (!email) return null;
  return email.endsWith('@local.invalid') ? null : email;
};

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// JWT verification middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    req.user = user;
    next();
  });
};

// ========== Authentication Routes ==========

// Register new user
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  const identifier = String(req.body.identifier || req.body.email || req.body.phone || '').trim();
  const identifierType = req.body.identifierType;

  if (!username || !identifier || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const resolvedType = identifierType || (identifier.includes('@') ? 'email' : (/^\d{10}$/.test(identifier) ? 'phone' : null));
  if (!resolvedType) {
    return res.status(400).json({ error: 'Identifier must be a 10-digit phone number or an email address.' });
  }
  if (!['email', 'phone'].includes(resolvedType)) {
    return res.status(400).json({ error: 'Unsupported identifier type.' });
  }

  let email = null;
  let normalizedPhone = null;

  if (resolvedType === 'phone') {
    normalizedPhone = normalizePhone(identifier);
    if (!/^\d{10}$/.test(normalizedPhone)) {
      return res.status(400).json({ error: 'Phone number must be exactly 10 digits.' });
    }
    // users.email is NOT NULL in current schema, so keep a deterministic placeholder for phone-only signups.
    email = `phone-${normalizedPhone}@local.invalid`;
  } else if (resolvedType === 'email') {
    email = normalizeEmail(identifier);
    if (!email.includes('@')) {
      return res.status(400).json({ error: 'Email must include @.' });
    }
  } else {
    return res.status(400).json({ error: 'Unsupported identifier type.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const registerQuery = 'INSERT INTO users (username, email, phone, password) VALUES (?, ?, ?, ?)';
    const registerParams = [username, email, normalizedPhone, hashedPassword];

    db.run(
      registerQuery,
      registerParams,
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'Username, email, or phone already exists' });
          }
          return res.status(500).json({ error: 'Error creating user' });
        }
        
        const token = jwt.sign(
          { id: this.lastID, username },
          process.env.JWT_SECRET,
          { expiresIn: '24h' }
        );
        
        res.status(201).json({
          message: 'User created successfully',
          token,
          user: {
            id: this.lastID,
            username,
            email: resolvedType === 'email' ? email : null,
            ...(normalizedPhone ? { phone: normalizedPhone } : {})
          }
        });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  const identifier = (req.body.identifier || req.body.phone || req.body.email || '').trim();
  const identifierType = req.body.identifierType;
  const { password } = req.body;

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Identifier and password required' });
  }

  const normalized = normalizePhone(identifier);
  const inferredType = identifier.includes('@') ? 'email' : (normalized.length === 10 ? 'phone' : null);
  const resolvedType = identifierType || inferredType;
  const isPhone = resolvedType === 'phone';

  if (!resolvedType) {
    return res.status(400).json({ error: 'Identifier must be a 10-digit phone number or an email address.' });
  }
  if (!['email', 'phone'].includes(resolvedType)) {
    return res.status(400).json({ error: 'Unsupported identifier type.' });
  }

  const handleSuccessfulLogin = async (user) => {
    // Check password
    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Reset failed attempts
    db.run('UPDATE users SET failed_attempts = 0 WHERE id = ?', [user.id]);

    const token = jwt.sign(
      { id: user.id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: toClientEmail(user.email),
        phone: user.phone || null
      }
    });
  };

  if (!isPhone) {
    const normalizedEmail = normalizeEmail(identifier);
    return db.get('SELECT * FROM users WHERE LOWER(email) = ?', [normalizedEmail], async (err, user) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      return handleSuccessfulLogin(user);
    });
  }

  db.get('SELECT * FROM users WHERE phone = ?', [normalized], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    if (user) return handleSuccessfulLogin(user);

    // Fallback for legacy rows where phone may have been stored with formatting or +1 prefix.
    const strippedPhoneExpr = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '-', ''), '(', ''), ')', ''), ' ', ''), '+', ''), '.', '')";
    const fallbackQuery = `SELECT * FROM users WHERE ${strippedPhoneExpr} IN (?, ?)`;

    db.get(fallbackQuery, [normalized, `1${normalized}`], async (fallbackErr, fallbackUser) => {
      if (fallbackErr) return res.status(500).json({ error: 'Server error' });
      if (!fallbackUser) return res.status(401).json({ error: 'Invalid credentials' });
      return handleSuccessfulLogin(fallbackUser);
    });
  });
});

    

// Get current user
app.get('/api/auth/me', authenticateToken, (req, res) => {
  db.get('SELECT id, username, email, phone FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Server error' });
    }
    res.json({
      ...user,
      email: toClientEmail(user.email)
    });
  });
});

// ========== Device Routes ==========

// Get all devices for a user
app.get('/api/devices', authenticateToken, (req, res) => {
  db.all('SELECT * FROM devices WHERE user_id = ?', [req.user.id], (err, devices) => {
    if (err) {
      return res.status(500).json({ error: 'Error fetching devices' });
    }
    res.json(devices);
  });
});

// Add new device
app.post('/api/devices', authenticateToken, (req, res) => {
  console.log("LOGIN BODY:", req.body);
  const { device_name, device_type, device_id } = req.body;

  if (!device_name || !device_type || !device_id) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  db.run(
    'INSERT INTO devices (user_id, device_name, device_type, device_id, status) VALUES (?, ?, ?, ?, ?)',
    [req.user.id, device_name, device_type, device_id, 'online'],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(409).json({ error: 'Device ID already exists' });
        }
        return res.status(500).json({ error: 'Error adding device' });
      }
      
      res.status(201).json({
        message: 'Device added successfully',
        device: {
          id: this.lastID,
          device_name,
          device_type,
          device_id,
          status: 'online'
        }
      });
    }
  );
});

// Delete device
app.delete('/api/devices/:id', authenticateToken, (req, res) => {
  const deviceId = req.params.id;
  
  db.run(
    'DELETE FROM devices WHERE id = ? AND user_id = ?',
    [deviceId, req.user.id],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Error deleting device' });
      }
      
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Device not found' });
      }
      
      res.json({ message: 'Device deleted successfully' });
    }
  );
});

// ========== Sensor Data Routes ==========

// Get sensor data for a device
app.get('/api/sensor-data/:deviceId', authenticateToken, (req, res) => {
  const { deviceId } = req.params;
  const limit = req.query.limit || 50;
  
  db.get(
    'SELECT * FROM devices WHERE device_id = ? AND user_id = ?',
    [deviceId, req.user.id],
    (err, device) => {
      if (err || !device) {
        return res.status(404).json({ error: 'Device not found' });
      }
      
      db.all(
        'SELECT * FROM sensor_data WHERE device_id = ? ORDER BY timestamp DESC LIMIT ?',
        [deviceId, limit],
        (err, data) => {
          if (err) {
            return res.status(500).json({ error: 'Error fetching sensor data' });
          }
          res.json(data);
        }
      );
    }
  );
});

// Demo: Generate random sensor data
app.post('/api/demo/generate-data/:deviceId', authenticateToken, (req, res) => {
  const { deviceId } = req.params;
  
  const temperature = (Math.random() * 15 + 18).toFixed(2);
  const humidity = (Math.random() * 30 + 40).toFixed(2);
  const pressure = (Math.random() * 50 + 980).toFixed(2);
  
  db.run(
    'INSERT INTO sensor_data (device_id, temperature, humidity, pressure) VALUES (?, ?, ?, ?)',
    [deviceId, temperature, humidity, pressure],
    function(err) {
      if (err) {
        return res.status(500).json({ error: 'Error generating data' });
      }
      res.json({ temperature, humidity, pressure });
    }
  );
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop');
});
