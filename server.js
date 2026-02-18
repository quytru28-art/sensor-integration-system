require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

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
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    db.run(
      'INSERT INTO users (username, email, password) VALUES (?, ?, ?)',
      [username, email, hashedPassword],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) {
            return res.status(409).json({ error: 'Username or email already exists' });
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
          user: { id: this.lastID, username, email }
        });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Server error' });
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check if account is locked
    if (user.is_locked === 1) {
      return res.status(403).json({ 
        error: 'Account locked due to too many failed attempts.' 
      });
    }

    try {
      const validPassword = await bcrypt.compare(password, user.password);

      //If password is wrong
      if (!validPassword) {
        const newAttempts = (user.failed_attempts || 0) + 1;
      
      //Lock account after 3 failed attempts
        if (newAttempts >= 3) {
          db.run(
            'UPDATE users SET failed_attempts = ?, is_locked = 1 WHERE id = ?',
            [newAttempts, user.id],
            (updateErr) => {
              if (updateErr) {
                console.error('Error locking account:', updateErr);
              }
          }
        );

          return res.status(403).json({ 
            error: 'Account locked after 3 failed attempts.' 
          });
        } else {
          db.run(
            'UPDATE users SET failed_attempts = ? WHERE id = ?',
            [newAttempts, user.id],
            (updateErr) => {
              if (updateErr) {
                console.error('Error updating failed attempts:', updateErr);
              }
            }
          );

          return res.status(401).json({ 
            error: `Invalid credentials. ${3 - newAttempts} attempts left.` 
          });
        }
      }

      //If password is correct
      db.run(
        'UPDATE users SET failed_attempts = 0 WHERE id = ?',
        [user.id],
        (updateErr) => {
          if (updateErr) {
            console.error('Error resetting failed attempts:', updateErr);
          }
        }
      );

      const token = jwt.sign(
        { id: user.id, username: user.username },
        process.env.JWT_SECRET,
        { expiresIn: '24h' }
      );

      res.json({
        message: 'Login successful',
        token,
        user: { id: user.id, username: user.username, email: user.email }
      });

    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Server error' });
    }
  });
});

// Get current user
app.get('/api/auth/me', authenticateToken, (req, res) => {
  db.get('SELECT id, username, email FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err) {
      return res.status(500).json({ error: 'Server error' });
    }
    res.json(user);
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
