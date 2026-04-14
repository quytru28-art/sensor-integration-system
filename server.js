require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3001;

// ========== MAILER SETUP ==========
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  }
});

// ========== UTILITY FUNCTIONS ==========

const normalizePhone = (value = '') => {
  const digits = String(value).replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
};

const normalizeEmail = (value = '') => String(value).trim().toLowerCase();

const toClientEmail = (email) => {
  if (!email) return null;
  return email.endsWith('@local.invalid') ? null : email;
};

const validatePassword = (p) =>
  p.length >= 8 &&
  /[A-Z]/.test(p) &&
  /[a-z]/.test(p) &&
  /[0-9]/.test(p) &&
  /[^A-Za-z0-9]/.test(p);

const MAX_ATTEMPTS = 5;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ========== AUTHENTICATION MIDDLEWARE ==========

const baseAuthenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = user;
    next();
  });
};

const authenticateToken = (req, res, next) => {
  baseAuthenticateToken(req, res, () => {
    db.get('SELECT is_active FROM users WHERE id = ?', [req.user.id], (err, user) => {
      if (err) return res.status(500).json({ error: 'Database error' });
      if (!user || user.is_active === 0) {
        return res.status(403).json({
          error: 'Your account has been deactivated. Please contact the administrator.',
          disabled: true
        });
      }
      next();
    });
  });
};

const requireAdmin = (req, res, next) => {
  db.get('SELECT is_admin FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err || !user || user.is_admin !== 1) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
};

const logAdminAction = (adminId, action, targetUserId, details, ipAddress) => {
  db.run(
    'INSERT INTO activity_logs (user_id, action, target_user_id, details, ip_address) VALUES (?, ?, ?, ?, ?)',
    [adminId, action, targetUserId, details, ipAddress],
    (err) => { if (err) console.error('Error logging admin action:', err); }
  );
};

const sendFailedLoginEmail = async (user, req, reason) => {
  db.get('SELECT alert_on_failed_login FROM users WHERE id = ?', [user.id], async (err, u) => {
    if (err || !u || u.alert_on_failed_login === 0 || !process.env.GMAIL_USER) return;
    const recipient = toClientEmail(user.email) || process.env.GMAIL_USER;
    try {
      await mailer.sendMail({
        from: `"Sensor System" <${process.env.GMAIL_USER}>`,
        to: recipient,
        subject: `⚠️ Failed Login — ${user.username}`,
        html: `<div style="font-family:sans-serif;padding:20px;"><h3>Failed Login Attempt</h3><p><strong>User:</strong> ${user.username}</p><p><strong>Reason:</strong> ${reason}</p><p><strong>Time:</strong> ${new Date().toLocaleString()}</p><p><strong>IP:</strong> ${req.ip || req.connection?.remoteAddress || 'unknown'}</p></div>`
      });
    } catch (e) { console.error('Failed login email error:', e); }
  });
};

// ========== AUTHENTICATION ROUTES ==========

// Register
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  const identifier = String(req.body.identifier || req.body.email || req.body.phone || '').trim();
  const identifierType = req.body.identifierType;

  if (!username || !identifier || !password) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({ error: 'Password does not meet requirements.' });
  }

  const resolvedType = identifierType || (identifier.includes('@') ? 'email' : (/^\d{10}$/.test(identifier) ? 'phone' : null));
  if (!resolvedType || !['email', 'phone'].includes(resolvedType)) {
    return res.status(400).json({ error: 'Identifier must be a 10-digit phone number or an email address.' });
  }

  let email = null;
  let normalizedPhone = null;

  if (resolvedType === 'phone') {
    normalizedPhone = normalizePhone(identifier);
    if (!/^\d{10}$/.test(normalizedPhone)) return res.status(400).json({ error: 'Phone number must be exactly 10 digits.' });
    email = `phone-${normalizedPhone}@local.invalid`;
  } else {
    email = normalizeEmail(identifier);
    if (!email.includes('@')) return res.status(400).json({ error: 'Email must include @.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(
      'INSERT INTO users (username, email, phone, password) VALUES (?, ?, ?, ?)',
      [username, email, normalizedPhone, hashedPassword],
      function(err) {
        if (err) {
          if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username, email, or phone already exists' });
          return res.status(500).json({ error: 'Error creating user' });
        }
        const token = jwt.sign({ id: this.lastID, username }, process.env.JWT_SECRET, { expiresIn: '24h' });
        res.status(201).json({
          message: 'User created successfully',
          token,
          user: { id: this.lastID, username, email: resolvedType === 'email' ? email : null, phone: normalizedPhone || null, is_admin: 0, must_change_password: 0 }
        });
      }
    );
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// Login handler
const handleLogin = async (req, res, user) => {
  const { password } = req.body;

  if (user.is_active === 0) {
    return res.status(403).json({
      error: 'Your account has been deactivated. Please contact the administrator to reactivate.',
      disabled: true
    });
  }

  if (user.is_locked === 1) {
    return res.status(403).json({
      error: `Account locked after ${MAX_ATTEMPTS} failed attempts. Use "Forgot Password" or contact admin.`,
      locked: true
    });
  }

  const validPassword = await bcrypt.compare(password, user.password);

  if (!validPassword) {
    const newAttempts = (user.failed_attempts || 0) + 1;
    db.run('UPDATE users SET failed_attempts = ? WHERE id = ?', [newAttempts, user.id]);
    if (newAttempts >= MAX_ATTEMPTS) {
      db.run('UPDATE users SET is_locked = 1 WHERE id = ?', [user.id]);
      sendFailedLoginEmail(user, req, 'Account locked after 5 failed attempts');
      return res.status(403).json({
        error: `Account locked after ${MAX_ATTEMPTS} failed attempts. Use "Forgot Password" or contact admin.`,
        locked: true
      });
    }
    sendFailedLoginEmail(user, req, 'Invalid password attempt');
    const left = MAX_ATTEMPTS - newAttempts;
    return res.status(401).json({ error: `Invalid credentials. ${left} attempt${left === 1 ? '' : 's'} left before lockout.` });
  }

  db.run('UPDATE users SET failed_attempts = 0, is_locked = 0, last_login = ? WHERE id = ?', [new Date().toISOString(), user.id]);

  // MFA check
  db.get('SELECT mfa_enabled, email FROM users WHERE id = ?', [user.id], async (err, u) => {
    if (!err && u && u.mfa_enabled === 1) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      db.run('DELETE FROM mfa_tokens WHERE user_id = ?', [user.id], () => {
        db.run('INSERT INTO mfa_tokens (user_id, code, expires_at) VALUES (?, ?, ?)', [user.id, otp, expires], async () => {
          await sendMfaEmail({ ...user, email: u.email }, otp);
          const mfaToken = jwt.sign({ id: user.id, mfa_pending: true }, process.env.JWT_SECRET, { expiresIn: '10m' });
          res.json({ mfa_required: true, mfa_token: mfaToken });
        });
      });
      return;
    }

    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '24h' });
    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: toClientEmail(user.email),
        phone: user.phone || null,
        is_admin: user.is_admin || 0,
        must_change_password: user.must_change_password || 0
      }
    });
  });
};

// Login
app.post('/api/auth/login', (req, res) => {
  const identifier = (req.body.identifier || req.body.phone || req.body.email || '').trim();
  const identifierType = req.body.identifierType;
  const { password } = req.body;

  if (!identifier || !password) return res.status(400).json({ error: 'Identifier and password required' });

  const normalized = normalizePhone(identifier);
  const inferredType = identifier.includes('@') ? 'email' : (normalized.length === 10 ? 'phone' : null);
  const resolvedType = identifierType || inferredType;
  const isPhone = resolvedType === 'phone';

  if (!resolvedType) return res.status(400).json({ error: 'Identifier must be a 10-digit phone number or an email address.' });

  if (!isPhone) {
    const normalizedEmail = normalizeEmail(identifier);
    return db.get('SELECT * FROM users WHERE LOWER(email) = ?', [normalizedEmail], async (err, user) => {
      if (err) return res.status(500).json({ error: 'Server error' });
      if (!user) return res.status(401).json({ error: 'Invalid credentials' });
      return handleLogin(req, res, user);
    });
  }

  db.get('SELECT * FROM users WHERE phone = ?', [normalized], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    if (user) return handleLogin(req, res, user);
    const strippedExpr = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '-', ''), '(', ''), ')', ''), ' ', ''), '+', ''), '.', '')";
    db.get(`SELECT * FROM users WHERE ${strippedExpr} IN (?, ?)`, [normalized, `1${normalized}`], async (fallbackErr, fallbackUser) => {
      if (fallbackErr) return res.status(500).json({ error: 'Server error' });
      if (!fallbackUser) return res.status(401).json({ error: 'Invalid credentials' });
      return handleLogin(req, res, fallbackUser);
    });
  });
});

// Get current user
app.get('/api/auth/me', authenticateToken, (req, res) => {
  db.get('SELECT id, username, email, phone, is_admin, must_change_password, retention_days, alert_on_failed_login FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    res.json({ ...user, email: toClientEmail(user.email), retention_days: user.retention_days ?? 365, alert_on_failed_login: user.alert_on_failed_login ?? 1 });
  });
});

// ========== FORGOT PASSWORD ==========

app.post('/api/auth/forgot-password', (req, res) => {
  const identifier = (req.body.identifier || '').trim();
  if (!identifier) return res.status(400).json({ error: 'Email or phone required' });

  const isEmail = identifier.includes('@');
  const query = isEmail ? 'SELECT * FROM users WHERE LOWER(email) = ?' : 'SELECT * FROM users WHERE phone = ?';
  const param = isEmail ? identifier.toLowerCase() : normalizePhone(identifier);

  db.get(query, [param], async (err, user) => {
    if (err) return res.status(500).json({ error: 'Server error' });
    if (!user) return res.status(404).json({ error: 'No account found with that email or phone.' });
    if (user.is_active === 0) return res.status(403).json({ error: 'This account has been deactivated. Contact the administrator.' });

    try {
      const tempPassword = 'Temp' + Math.random().toString(36).substring(2, 10) + '!';
      const hashedPassword = await bcrypt.hash(tempPassword, 10);

      db.run(
        'UPDATE users SET password = ?, must_change_password = 1, is_locked = 0, failed_attempts = 0 WHERE id = ?',
        [hashedPassword, user.id],
        async (err) => {
          if (err) return res.status(500).json({ error: 'Error resetting password' });

          const displayContact = toClientEmail(user.email) || (user.phone ? `Phone: ${user.phone}` : 'N/A');

          try {
            await mailer.sendMail({
              from: `"Sensor System" <${process.env.GMAIL_USER}>`,
              to: process.env.GMAIL_USER,
              subject: `🔑 Password Reset Request — ${user.username}`,
              html: `
                <div style="font-family:sans-serif;max-width:520px;margin:auto;border:1px solid #ddd;border-radius:8px;overflow:hidden;">
                  <div style="background:#667eea;padding:20px;color:white;">
                    <h2 style="margin:0">🔑 Password Reset Request</h2>
                  </div>
                  <div style="padding:24px;">
                    <p><strong>Username:</strong> ${user.username}</p>
                    <p><strong>Contact:</strong> ${displayContact}</p>
                    <p style="margin-top:16px;"><strong>Temporary Password:</strong></p>
                    <div style="font-size:26px;font-family:monospace;background:#f0f0f0;padding:14px;border-radius:6px;letter-spacing:4px;text-align:center;margin:10px 0;">${tempPassword}</div>
                    <p style="color:#cc0000;font-size:13px;">⚠️ Share this securely with the user. They will be required to set a new password on next login.</p>
                    <p style="color:#888;font-size:12px;margin-top:20px;">Requested at: ${new Date().toLocaleString()}</p>
                  </div>
                </div>
              `
            });
            res.json({ message: 'A password reset request has been sent to the administrator. Please contact them to get your temporary password, then log in to set a new one.' });
          } catch (emailErr) {
            console.error('Email send error:', emailErr);
            res.status(500).json({ error: 'Password was reset but the notification email failed. Please contact the administrator directly at truhoang1711@gmail.com' });
          }
        }
      );
    } catch { res.status(500).json({ error: 'Server error' }); }
  });
});

// ========== CHANGE PASSWORD ==========

app.post('/api/account/change-password', authenticateToken, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: 'New password required' });
  if (!validatePassword(newPassword)) return res.status(400).json({ error: 'Password does not meet all requirements.' });

  try {
    const hashed = await bcrypt.hash(newPassword, 10);
    db.run('UPDATE users SET password = ?, must_change_password = 0 WHERE id = ?', [hashed, req.user.id], function(err) {
      if (err) return res.status(500).json({ error: 'Error changing password' });
      res.json({ message: 'Password changed successfully.' });
    });
  } catch { res.status(500).json({ error: 'Server error' }); }
});

// ========== UPDATE ACCOUNT (email, phone, retention, alert) ==========
app.patch('/api/account', authenticateToken, (req, res) => {
  const { email, phone, retention_days, alert_on_failed_login } = req.body;
  const updates = [];
  const params = [];

  if (email !== undefined && String(email).trim()) {
    const norm = normalizeEmail(email);
    if (!norm.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    updates.push('email = ?');
    params.push(norm);
  }
  if (phone !== undefined) {
    const norm = normalizePhone(phone);
    if (norm && norm.length !== 10) return res.status(400).json({ error: 'Phone must be 10 digits or empty' });
    updates.push('phone = ?');
    params.push(norm || null);
  }
  if (retention_days !== undefined) {
    const d = parseInt(retention_days, 10);
    if (isNaN(d) || d < 1 || d > 3650) return res.status(400).json({ error: 'Retention must be 1–3650 days' });
    updates.push('retention_days = ?');
    params.push(d);
  }
  if (alert_on_failed_login !== undefined) {
    updates.push('alert_on_failed_login = ?');
    params.push(alert_on_failed_login ? 1 : 0);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

  params.push(req.user.id);
  db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params, function(err) {
    if (err) {
      if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Email or phone already in use' });
      return res.status(500).json({ error: 'Error updating account' });
    }
    res.json({ message: 'Account updated successfully' });
  });
});

// ========== SELF DEACTIVATE ==========

app.post('/api/account/deactivate', authenticateToken, (req, res) => {
  db.run(
    'UPDATE users SET is_active = 0, disabled_at = ?, disabled_by = NULL WHERE id = ?',
    [new Date().toISOString(), req.user.id],
    function(err) {
      if (err) return res.status(500).json({ error: 'Error deactivating account' });
      res.json({ message: 'Account deactivated. It will be permanently deleted after 2 months unless reactivated by an admin.' });
    }
  );
});

// ========== DEVICE ROUTES ==========

const OFFLINE_MINUTES = 5;
app.get('/api/devices', authenticateToken, (req, res) => {
  db.all('SELECT * FROM devices WHERE user_id = ?', [req.user.id], (err, devices) => {
    if (err) return res.status(500).json({ error: 'Error fetching devices' });
    const now = Date.now();
    const limitMs = OFFLINE_MINUTES * 60 * 1000;
    const result = (devices || []).map((d) => {
      const lastSeen = d.last_seen_at ? new Date(d.last_seen_at).getTime() : 0;
      const status = lastSeen && (now - lastSeen) < limitMs ? 'online' : 'offline';
      return { ...d, status, last_seen_at: d.last_seen_at };
    });
    res.json(result);
  });
});

app.post('/api/devices', authenticateToken, (req, res) => {
  const { device_name, device_type, device_id } = req.body;
  if (!device_name || !device_type || !device_id) return res.status(400).json({ error: 'All fields are required' });
  db.run(
    'INSERT INTO devices (user_id, device_name, device_type, device_id, status) VALUES (?, ?, ?, ?, ?)',
    [req.user.id, device_name, device_type, device_id, 'online'],
    function(err) {
      if (err) {
        if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Device ID already exists' });
        return res.status(500).json({ error: 'Error adding device' });
      }
      res.status(201).json({ message: 'Device added successfully', device: { id: this.lastID, device_name, device_type, device_id, status: 'online' } });
    }
  );
});

app.patch('/api/devices/:id', authenticateToken, (req, res) => {
  const { device_name, device_type, collection_interval_minutes, min_temperature, max_temperature, min_humidity, max_humidity, min_pressure, max_pressure } = req.body;
  if (!device_name || !device_type) return res.status(400).json({ error: 'Device name and type are required' });
  const interval = collection_interval_minutes != null ? Math.max(1, Math.min(1440, parseInt(collection_interval_minutes, 10) || 10)) : (req.body.collection_interval_minutes === '' ? null : undefined);
  const def = (v) => (v === '' || v === null || v === undefined) ? null : (parseFloat(v) || null);
  const params = [device_name, device_type, interval ?? 10, def(min_temperature), def(max_temperature), def(min_humidity), def(max_humidity), def(min_pressure), def(max_pressure), req.params.id, req.user.id];
  db.run(
    'UPDATE devices SET device_name = ?, device_type = ?, collection_interval_minutes = ?, min_temperature = ?, max_temperature = ?, min_humidity = ?, max_humidity = ?, min_pressure = ?, max_pressure = ? WHERE id = ? AND user_id = ?',
    params,
    function(err) {
      if (err) return res.status(500).json({ error: 'Error updating device' });
      if (this.changes === 0) return res.status(404).json({ error: 'Device not found' });
      db.get('SELECT * FROM devices WHERE id = ?', [req.params.id], (err, device) => {
        if (err || !device) return res.status(500).json({ error: 'Error fetching updated device' });
        res.json({ message: 'Device updated successfully', device });
      });
    }
  );
});

app.delete('/api/devices/:id', authenticateToken, (req, res) => {
  db.run('DELETE FROM devices WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], function(err) {
    if (err) return res.status(500).json({ error: 'Error deleting device' });
    if (this.changes === 0) return res.status(404).json({ error: 'Device not found' });
    res.json({ message: 'Device deleted successfully' });
  });
});

// ========== SENSOR DATA ROUTES ==========

const sanitizeDatetime = (s) => {
  if (!s || typeof s !== 'string') return null;
  const t = s.trim().replace('T', ' ');
  return /^\d{4}-\d{2}-\d{2}/.test(t) ? (t.length <= 16 ? t + ':00' : t) : null;
};

app.get('/api/sensor-data/:deviceId', authenticateToken, (req, res) => {
  const { deviceId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const from = sanitizeDatetime(req.query.from);
  const to = sanitizeDatetime(req.query.to);

  db.get('SELECT * FROM devices WHERE device_id = ? AND user_id = ?', [deviceId, req.user.id], (err, device) => {
    if (err || !device) return res.status(404).json({ error: 'Device not found' });

    let sql = 'SELECT * FROM sensor_data WHERE device_id = ?';
    const params = [deviceId];

    if (from && to) {
      sql += ' AND datetime(timestamp) BETWEEN datetime(?) AND datetime(?)';
      params.push(from, to);
    } else if (from) {
      sql += ' AND datetime(timestamp) >= datetime(?)';
      params.push(from);
    } else if (to) {
      sql += ' AND datetime(timestamp) <= datetime(?)';
      params.push(to);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    db.all(sql, params, (err, data) => {
      if (err) return res.status(500).json({ error: 'Error fetching sensor data' });
      res.json(data);
    });
  });
});

app.get('/api/sensor-data/:deviceId/export', authenticateToken, (req, res) => {
  const { deviceId } = req.params;
  const format = (req.query.format || 'csv').toLowerCase();
  const from = sanitizeDatetime(req.query.from);
  const to = sanitizeDatetime(req.query.to);
  const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);

  db.get('SELECT * FROM devices WHERE device_id = ? AND user_id = ?', [deviceId, req.user.id], (err, device) => {
    if (err || !device) return res.status(404).json({ error: 'Device not found' });

    let sql = 'SELECT timestamp, temperature, humidity, pressure FROM sensor_data WHERE device_id = ?';
    const params = [deviceId];

    if (from && to) {
      sql += ' AND datetime(timestamp) BETWEEN datetime(?) AND datetime(?)';
      params.push(from, to);
    } else if (from) {
      sql += ' AND datetime(timestamp) >= datetime(?)';
      params.push(from);
    } else if (to) {
      sql += ' AND datetime(timestamp) <= datetime(?)';
      params.push(to);
    }

    sql += ' ORDER BY timestamp DESC LIMIT ?';
    params.push(limit);

    db.all(sql, params, (err, rows) => {
      if (err) return res.status(500).json({ error: 'Error exporting sensor data' });
      if (format === 'csv') {
        const header = 'timestamp,temperature,humidity,pressure\n';
        const body = (rows || []).map(r => `${r.timestamp || ''},${r.temperature ?? ''},${r.humidity ?? ''},${r.pressure ?? ''}`).join('\n');
        const csv = header + body;
        const filename = `sensor-data-${device.device_id}-${new Date().toISOString().slice(0, 10)}.csv`;
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(csv);
      } else {
        res.json(rows);
      }
    });
  });
});

const sendThresholdAlertEmail = async (device, user, reading, breaches) => {
  if (!process.env.GMAIL_USER) return;
  const recipient = toClientEmail(user.email) || process.env.GMAIL_USER;
  try {
    await mailer.sendMail({
      from: `"Sensor System" <${process.env.GMAIL_USER}>`,
      to: recipient,
      subject: `⚠️ Sensor Alert — ${device.device_name} (${device.device_id})`,
      html: `<div style="font-family:sans-serif;padding:20px;"><h3>Threshold Exceeded</h3><p><strong>Device:</strong> ${device.device_name} (${device.device_id})</p><p><strong>Breaches:</strong> ${breaches.join('; ')}</p><p>Temp: ${reading.temp}°C, Humidity: ${reading.humidity}%, Pressure: ${reading.pressure} hPa</p><p><strong>Time:</strong> ${new Date().toLocaleString()}</p></div>`
    });
  } catch (e) { console.error('Threshold alert email error:', e); }
};

app.post('/api/demo/generate-data/:deviceId', authenticateToken, (req, res) => {
  const { deviceId } = req.params;
  const temperature = parseFloat((Math.random() * 15 + 18).toFixed(2));
  const humidity = parseFloat((Math.random() * 30 + 40).toFixed(2));
  const pressure = parseFloat((Math.random() * 50 + 980).toFixed(2));

  db.get('SELECT d.*, u.email, u.alert_on_failed_login FROM devices d JOIN users u ON d.user_id = u.id WHERE d.device_id = ? AND d.user_id = ?', [deviceId, req.user.id], (err, device) => {
    if (err || !device) return res.status(404).json({ error: 'Device not found' });

    db.run('INSERT INTO sensor_data (device_id, temperature, humidity, pressure) VALUES (?, ?, ?, ?)', [deviceId, temperature, humidity, pressure], function(insErr) {
      if (insErr) return res.status(500).json({ error: 'Error generating data' });

      db.run('UPDATE devices SET last_seen_at = ?, status = ? WHERE device_id = ?', [new Date().toISOString(), 'online', deviceId]);

      const breaches = [];
      if (device.min_temperature != null && temperature < device.min_temperature) breaches.push(`Temp ${temperature} < min ${device.min_temperature}`);
      if (device.max_temperature != null && temperature > device.max_temperature) breaches.push(`Temp ${temperature} > max ${device.max_temperature}`);
      if (device.min_humidity != null && humidity < device.min_humidity) breaches.push(`Humidity ${humidity} < min ${device.min_humidity}`);
      if (device.max_humidity != null && humidity > device.max_humidity) breaches.push(`Humidity ${humidity} > max ${device.max_humidity}`);
      if (device.min_pressure != null && pressure < device.min_pressure) breaches.push(`Pressure ${pressure} < min ${device.min_pressure}`);
      if (device.max_pressure != null && pressure > device.max_pressure) breaches.push(`Pressure ${pressure} > max ${device.max_pressure}`);
      if (breaches.length > 0) {
        db.get('SELECT email FROM users WHERE id = ?', [req.user.id], (e, u) => {
          sendThresholdAlertEmail(device, u || { email: device.email }, { temp: temperature, humidity, pressure }, breaches);
        });
      }

      // Check custom alert rules (US18)
      db.all('SELECT * FROM alert_rules WHERE device_id = ? AND user_id = ? AND enabled = 1', [deviceId, req.user.id], (e, rules) => {
        if (!rules || rules.length === 0) return;
        const reading = { temperature, humidity, pressure };
        const ruleBreaches = rules.filter(r => {
          const val = reading[r.metric];
          if (val === undefined || val === null) return false;
          return r.operator === 'above' ? val > r.threshold : val < r.threshold;
        });
        if (ruleBreaches.length > 0) {
          db.get('SELECT email FROM users WHERE id = ?', [req.user.id], (e, u) => {
            const msgs = ruleBreaches.map(r => `"${r.name}": ${r.metric} ${r.operator} ${r.threshold} (got ${reading[r.metric]})`);
            sendThresholdAlertEmail(device, u || { email: device.email }, { temp: temperature, humidity, pressure }, msgs);
          });
        }
      });

      res.json({ temperature, humidity, pressure });
    });
  });
});

// ========== ADMIN ROUTES ==========

app.get('/api/admin/users', authenticateToken, requireAdmin, (req, res) => {
  db.all(`
    SELECT u.id, u.username, u.email, u.phone,
      u.is_admin, u.is_active, u.is_locked, u.created_at,
      COUNT(d.id) as device_count
    FROM users u
    LEFT JOIN devices d ON u.id = d.user_id
    GROUP BY u.id ORDER BY u.created_at DESC
  `, (err, users) => {
    if (err) return res.status(500).json({ error: 'Error fetching users' });
    res.json(users.map(u => ({ ...u, email: toClientEmail(u.email) })));
  });
});

app.get('/api/admin/stats', authenticateToken, requireAdmin, (req, res) => {
  const stats = {};
  db.get('SELECT COUNT(*) as count FROM users', (err, r) => {
    stats.totalUsers = r ? r.count : 0;
    db.get('SELECT COUNT(*) as count FROM devices', (err, r) => {
      stats.totalDevices = r ? r.count : 0;
      db.get('SELECT COUNT(*) as count FROM sensor_data', (err, r) => {
        stats.totalReadings = r ? r.count : 0;
        db.get("SELECT COUNT(*) as count FROM users WHERE DATE(created_at) = DATE('now')", (err, r) => {
          stats.newUsersToday = r ? r.count : 0;
          db.get("SELECT COUNT(*) as count FROM users WHERE is_locked = 1", (err, r) => {
            stats.lockedAccounts = r ? r.count : 0;
            db.get("SELECT COUNT(*) as count FROM users WHERE is_active = 0 AND disabled_by IS NULL", (err, r) => {
              stats.deactivatedAccounts = r ? r.count : 0;
              res.json(stats);
            });
          });
        });
      });
    });
  });
});

app.get('/api/admin/users/:id/details', authenticateToken, requireAdmin, (req, res) => {
  db.get(`
    SELECT u.id, u.username, u.email, u.phone, u.is_admin, u.is_active, u.is_locked,
      u.failed_attempts, u.created_at, u.last_login, u.disabled_at, u.must_change_password,
      disabler.username as disabled_by_username,
      COUNT(DISTINCT d.id) as device_count,
      COUNT(DISTINCT sd.id) as reading_count
    FROM users u
    LEFT JOIN devices d ON u.id = d.user_id
    LEFT JOIN sensor_data sd ON d.device_id = sd.device_id
    LEFT JOIN users disabler ON u.disabled_by = disabler.id
    WHERE u.id = ? GROUP BY u.id
  `, [req.params.id], (err, user) => {
    if (err) return res.status(500).json({ error: 'Error fetching user details' });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ ...user, email: toClientEmail(user.email) });
  });
});

app.patch('/api/admin/users/:id/toggle-active', authenticateToken, requireAdmin, (req, res) => {
  const targetUserId = req.params.id;
  const adminId = req.user.id;
  if (parseInt(targetUserId) === adminId) return res.status(400).json({ error: 'Cannot disable your own account' });
  db.get('SELECT is_active, username, email FROM users WHERE id = ?', [targetUserId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    const newStatus = user.is_active === 1 ? 0 : 1;
    db.run(
      'UPDATE users SET is_active = ?, disabled_at = ?, disabled_by = ? WHERE id = ?',
      [newStatus, newStatus === 0 ? new Date().toISOString() : null, newStatus === 0 ? adminId : null, targetUserId],
      function(err) {
        if (err) return res.status(500).json({ error: 'Error updating user status' });
        logAdminAction(adminId, newStatus === 0 ? 'DISABLED_USER' : 'ENABLED_USER', targetUserId, JSON.stringify({ username: user.username }), req.ip);
        res.json({ message: `User ${newStatus === 0 ? 'disabled' : 'enabled'} successfully`, is_active: newStatus });
      }
    );
  });
});

app.patch('/api/admin/users/:id/unlock', authenticateToken, requireAdmin, (req, res) => {
  db.run('UPDATE users SET is_locked = 0, failed_attempts = 0 WHERE id = ?', [req.params.id], function(err) {
    if (err) return res.status(500).json({ error: 'Error unlocking account' });
    logAdminAction(req.user.id, 'UNLOCKED_USER', req.params.id, null, req.ip);
    res.json({ message: 'Account unlocked successfully' });
  });
});

app.post('/api/admin/users/:id/reset-password', authenticateToken, requireAdmin, async (req, res) => {
  const targetUserId = req.params.id;
  const adminId = req.user.id;
  if (parseInt(targetUserId) === adminId) return res.status(400).json({ error: 'Use profile settings to change your own password' });
  db.get('SELECT username, email FROM users WHERE id = ?', [targetUserId], async (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    try {
      const tempPassword = 'Temp' + Math.random().toString(36).substring(2, 10) + '!';
      const hashedPassword = await bcrypt.hash(tempPassword, 10);
      db.run('UPDATE users SET password = ?, must_change_password = 1, is_locked = 0, failed_attempts = 0 WHERE id = ?', [hashedPassword, targetUserId], function(err) {
        if (err) return res.status(500).json({ error: 'Error resetting password' });
        logAdminAction(adminId, 'RESET_PASSWORD', targetUserId, JSON.stringify({ username: user.username }), req.ip);
        res.json({ message: 'Password reset successfully', tempPassword, username: user.username, email: toClientEmail(user.email), note: 'Share this securely. User must set a new password on next login.' });
      });
    } catch { res.status(500).json({ error: 'Error resetting password' }); }
  });
});

app.delete('/api/admin/users/:id/permanent-delete', authenticateToken, requireAdmin, (req, res) => {
  const targetUserId = req.params.id;
  const adminId = req.user.id;
  if (parseInt(targetUserId) === adminId) return res.status(400).json({ error: 'Cannot delete your own account' });
  db.get('SELECT username, email FROM users WHERE id = ?', [targetUserId], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    db.run('DELETE FROM users WHERE id = ?', [targetUserId], function(err) {
      if (err) return res.status(500).json({ error: 'Error deleting user' });
      logAdminAction(adminId, 'PERMANENT_DELETE', targetUserId, JSON.stringify({ username: user.username }), req.ip);
      res.json({ message: 'User and all data deleted permanently' });
    });
  });
});

app.get('/api/admin/activity-logs', authenticateToken, requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  db.all(`
    SELECT al.*, u1.username as admin_username, u2.username as target_username
    FROM activity_logs al
    LEFT JOIN users u1 ON al.user_id = u1.id
    LEFT JOIN users u2 ON al.target_user_id = u2.id
    ORDER BY al.timestamp DESC LIMIT ?
  `, [limit], (err, logs) => {
    if (err) return res.status(500).json({ error: 'Error fetching logs' });
    res.json(logs);
  });
});

// ========== MFA ROUTES (US14) ==========

const sendMfaEmail = async (user, code) => {
  if (!process.env.GMAIL_USER) return;
  const recipient = toClientEmail(user.email) || process.env.GMAIL_USER;
  try {
    await mailer.sendMail({
      from: `"Sensor System" <${process.env.GMAIL_USER}>`,
      to: recipient,
      subject: `🔐 Your Login Verification Code`,
      html: `<div style="font-family:sans-serif;padding:24px;max-width:480px;">
        <h2 style="color:#667eea">Verification Code</h2>
        <p>Hello <strong>${user.username}</strong>, use this code to complete your login:</p>
        <div style="font-size:36px;font-family:monospace;background:#f0f4ff;padding:18px;border-radius:8px;text-align:center;letter-spacing:8px;font-weight:700;color:#333;">${code}</div>
        <p style="color:#888;font-size:13px;margin-top:16px;">This code expires in 10 minutes. If you did not request this, contact your administrator.</p>
      </div>`
    });
  } catch (e) { console.error('MFA email error:', e); }
};

// Enable MFA — sends a test OTP, user confirms with it
app.post('/api/auth/mfa/enable', authenticateToken, async (req, res) => {
  const { code } = req.body;
  db.get('SELECT * FROM users WHERE id = ?', [req.user.id], async (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });

    if (!code) {
      // Step 1: send OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString();
      db.run('DELETE FROM mfa_tokens WHERE user_id = ?', [user.id], () => {
        db.run('INSERT INTO mfa_tokens (user_id, code, expires_at) VALUES (?, ?, ?)', [user.id, otp, expires], async () => {
          await sendMfaEmail(user, otp);
          res.json({ message: 'Verification code sent to your email. Enter it to activate MFA.' });
        });
      });
    } else {
      // Step 2: verify OTP and enable
      db.get('SELECT * FROM mfa_tokens WHERE user_id = ? AND used = 0 AND datetime(expires_at) > datetime("now") ORDER BY id DESC LIMIT 1', [user.id], (err, token) => {
        if (err || !token || token.code !== code) return res.status(400).json({ error: 'Invalid or expired code.' });
        db.run('UPDATE mfa_tokens SET used = 1 WHERE id = ?', [token.id]);
        db.run('UPDATE users SET mfa_enabled = 1 WHERE id = ?', [user.id], () => {
          res.json({ message: 'MFA enabled successfully.' });
        });
      });
    }
  });
});

// Disable MFA
app.post('/api/auth/mfa/disable', authenticateToken, (req, res) => {
  db.run('UPDATE users SET mfa_enabled = 0 WHERE id = ?', [req.user.id], () => {
    db.run('DELETE FROM mfa_tokens WHERE user_id = ?', [req.user.id]);
    res.json({ message: 'MFA disabled.' });
  });
});

// Verify MFA code during login (called after password check returned mfa_required)
app.post('/api/auth/mfa/verify-login', (req, res) => {
  const { mfa_token, code } = req.body;
  if (!mfa_token || !code) return res.status(400).json({ error: 'mfa_token and code required' });

  let pending;
  try {
    pending = jwt.verify(mfa_token, process.env.JWT_SECRET);
  } catch { return res.status(401).json({ error: 'Invalid or expired MFA session.' }); }

  if (!pending.mfa_pending) return res.status(401).json({ error: 'Invalid MFA session.' });

  db.get('SELECT * FROM mfa_tokens WHERE user_id = ? AND used = 0 AND datetime(expires_at) > datetime("now") ORDER BY id DESC LIMIT 1', [pending.id], (err, token) => {
    if (err || !token || token.code !== String(code).trim()) return res.status(401).json({ error: 'Invalid or expired code.' });
    db.run('UPDATE mfa_tokens SET used = 1 WHERE id = ?', [token.id]);
    db.get('SELECT id, username, email, phone, is_admin, must_change_password FROM users WHERE id = ?', [pending.id], (err, user) => {
      if (err || !user) return res.status(500).json({ error: 'Server error' });
      const token2 = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, { expiresIn: '24h' });
      res.json({
        message: 'Login successful',
        token: token2,
        user: { id: user.id, username: user.username, email: toClientEmail(user.email), phone: user.phone || null, is_admin: user.is_admin || 0, must_change_password: user.must_change_password || 0 }
      });
    });
  });
});

// Get MFA status
app.get('/api/auth/mfa/status', authenticateToken, (req, res) => {
  db.get('SELECT mfa_enabled FROM users WHERE id = ?', [req.user.id], (err, user) => {
    if (err || !user) return res.status(404).json({ error: 'User not found' });
    res.json({ mfa_enabled: user.mfa_enabled === 1 });
  });
});

// ========== SENSOR GROUPS (US8, US9, US10) ==========

// List groups (owned + member)
app.get('/api/groups', authenticateToken, (req, res) => {
  db.all(`
    SELECT g.*, u.username as owner_username,
      (SELECT COUNT(*) FROM group_members WHERE group_id = g.id) as member_count,
      (SELECT COUNT(*) FROM group_devices WHERE group_id = g.id) as device_count,
      CASE WHEN g.owner_id = ? THEN 'owner' ELSE gm.role END as my_role
    FROM sensor_groups g
    LEFT JOIN group_members gm ON g.id = gm.group_id AND gm.user_id = ?
    JOIN users u ON g.owner_id = u.id
    WHERE g.owner_id = ? OR gm.user_id = ?
    ORDER BY g.created_at DESC
  `, [req.user.id, req.user.id, req.user.id, req.user.id], (err, groups) => {
    if (err) return res.status(500).json({ error: 'Error fetching groups' });
    res.json(groups || []);
  });
});

// Create group
app.post('/api/groups', authenticateToken, (req, res) => {
  const { name, description } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Group name is required' });
  db.run('INSERT INTO sensor_groups (owner_id, name, description) VALUES (?, ?, ?)',
    [req.user.id, String(name).trim(), description || null],
    function(err) {
      if (err) return res.status(500).json({ error: 'Error creating group' });
      res.status(201).json({ message: 'Group created', group: { id: this.lastID, name, description, owner_id: req.user.id, member_count: 0, device_count: 0, my_role: 'owner' } });
    }
  );
});

// Update group
app.patch('/api/groups/:id', authenticateToken, (req, res) => {
  const { name, description } = req.body;
  db.get('SELECT * FROM sensor_groups WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id], (err, g) => {
    if (err || !g) return res.status(404).json({ error: 'Group not found or not owner' });
    db.run('UPDATE sensor_groups SET name = ?, description = ? WHERE id = ?',
      [name || g.name, description !== undefined ? description : g.description, g.id],
      (err) => { if (err) return res.status(500).json({ error: 'Error updating group' }); res.json({ message: 'Group updated' }); }
    );
  });
});

// Delete group
app.delete('/api/groups/:id', authenticateToken, (req, res) => {
  db.run('DELETE FROM sensor_groups WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id], function(err) {
    if (err) return res.status(500).json({ error: 'Error deleting group' });
    if (this.changes === 0) return res.status(404).json({ error: 'Group not found or not owner' });
    res.json({ message: 'Group deleted' });
  });
});

// List group members
app.get('/api/groups/:id/members', authenticateToken, (req, res) => {
  db.get('SELECT id FROM sensor_groups WHERE id = ? AND (owner_id = ? OR EXISTS(SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?))',
    [req.params.id, req.user.id, req.params.id, req.user.id], (err, g) => {
    if (err || !g) return res.status(404).json({ error: 'Group not found or access denied' });
    db.all(`SELECT gm.id, gm.user_id, gm.role, gm.joined_at, u.username, u.email, u.phone
      FROM group_members gm JOIN users u ON gm.user_id = u.id WHERE gm.group_id = ? ORDER BY gm.joined_at`,
      [req.params.id], (err, members) => {
      if (err) return res.status(500).json({ error: 'Error fetching members' });
      res.json((members || []).map(m => ({ ...m, email: toClientEmail(m.email) })));
    });
  });
});

// Add member
app.post('/api/groups/:id/members', authenticateToken, (req, res) => {
  const { identifier, role } = req.body;
  const validRole = ['viewer', 'editor'].includes(role) ? role : 'viewer';
  if (!identifier) return res.status(400).json({ error: 'Username or email required' });

  db.get('SELECT id FROM sensor_groups WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id], (err, g) => {
    if (err || !g) return res.status(404).json({ error: 'Group not found or not owner' });

    const isEmail = String(identifier).includes('@');
    const query = isEmail ? 'SELECT id, username FROM users WHERE LOWER(email) = ?' : 'SELECT id, username FROM users WHERE username = ?';
    const param = isEmail ? normalizeEmail(identifier) : identifier;

    db.get(query, [param], (err, target) => {
      if (err || !target) return res.status(404).json({ error: 'User not found' });
      if (target.id === req.user.id) return res.status(400).json({ error: 'Cannot add yourself as a member (you are the owner)' });

      db.run('INSERT OR IGNORE INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
        [req.params.id, target.id, validRole], function(err) {
          if (err) return res.status(500).json({ error: 'Error adding member' });
          if (this.changes === 0) return res.status(409).json({ error: 'User is already a member' });
          res.status(201).json({ message: `${target.username} added as ${validRole}` });
        }
      );
    });
  });
});

// Update member role (US10)
app.patch('/api/groups/:id/members/:userId', authenticateToken, (req, res) => {
  const { role } = req.body;
  const validRole = ['viewer', 'editor'].includes(role) ? role : 'viewer';
  db.get('SELECT id FROM sensor_groups WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id], (err, g) => {
    if (err || !g) return res.status(403).json({ error: 'Not authorized' });
    db.run('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?',
      [validRole, req.params.id, req.params.userId], function(err) {
        if (err) return res.status(500).json({ error: 'Error updating role' });
        if (this.changes === 0) return res.status(404).json({ error: 'Member not found' });
        res.json({ message: 'Role updated' });
      }
    );
  });
});

// Remove member
app.delete('/api/groups/:id/members/:userId', authenticateToken, (req, res) => {
  const targetId = parseInt(req.params.userId);
  db.get('SELECT id, owner_id FROM sensor_groups WHERE id = ?', [req.params.id], (err, g) => {
    if (err || !g) return res.status(404).json({ error: 'Group not found' });
    // Owner can remove anyone; members can remove themselves
    if (g.owner_id !== req.user.id && targetId !== req.user.id) return res.status(403).json({ error: 'Not authorized' });
    db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [req.params.id, targetId], function(err) {
      if (err) return res.status(500).json({ error: 'Error removing member' });
      if (this.changes === 0) return res.status(404).json({ error: 'Member not found' });
      res.json({ message: 'Member removed' });
    });
  });
});

// List devices in group
app.get('/api/groups/:id/devices', authenticateToken, (req, res) => {
  db.get('SELECT id FROM sensor_groups WHERE id = ? AND (owner_id = ? OR EXISTS(SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?))',
    [req.params.id, req.user.id, req.params.id, req.user.id], (err, g) => {
    if (err || !g) return res.status(404).json({ error: 'Group not found or access denied' });
    db.all(`SELECT d.*, gd.added_at FROM group_devices gd JOIN devices d ON gd.device_id = d.device_id WHERE gd.group_id = ?`,
      [req.params.id], (err, devices) => {
      if (err) return res.status(500).json({ error: 'Error fetching devices' });
      res.json(devices || []);
    });
  });
});

// Add device to group (owner only)
app.post('/api/groups/:id/devices', authenticateToken, (req, res) => {
  const { device_id } = req.body;
  if (!device_id) return res.status(400).json({ error: 'device_id required' });
  db.get('SELECT id FROM sensor_groups WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id], (err, g) => {
    if (err || !g) return res.status(404).json({ error: 'Group not found or not owner' });
    db.get('SELECT device_id FROM devices WHERE device_id = ? AND user_id = ?', [device_id, req.user.id], (err, dev) => {
      if (err || !dev) return res.status(404).json({ error: 'Device not found or not yours' });
      db.run('INSERT OR IGNORE INTO group_devices (group_id, device_id) VALUES (?, ?)', [req.params.id, device_id], function(err) {
        if (err) return res.status(500).json({ error: 'Error adding device' });
        if (this.changes === 0) return res.status(409).json({ error: 'Device already in group' });
        res.status(201).json({ message: 'Device added to group' });
      });
    });
  });
});

// Remove device from group
app.delete('/api/groups/:id/devices/:deviceId', authenticateToken, (req, res) => {
  db.get('SELECT id FROM sensor_groups WHERE id = ? AND owner_id = ?', [req.params.id, req.user.id], (err, g) => {
    if (err || !g) return res.status(403).json({ error: 'Not authorized' });
    db.run('DELETE FROM group_devices WHERE group_id = ? AND device_id = ?', [req.params.id, req.params.deviceId], function(err) {
      if (err) return res.status(500).json({ error: 'Error removing device' });
      if (this.changes === 0) return res.status(404).json({ error: 'Device not in group' });
      res.json({ message: 'Device removed from group' });
    });
  });
});

// ========== CUSTOM ALERT RULES (US18) ==========

app.get('/api/devices/:deviceId/alert-rules', authenticateToken, (req, res) => {
  db.get('SELECT device_id FROM devices WHERE device_id = ? AND user_id = ?', [req.params.deviceId, req.user.id], (err, dev) => {
    if (err || !dev) return res.status(404).json({ error: 'Device not found' });
    db.all('SELECT * FROM alert_rules WHERE device_id = ? AND user_id = ? ORDER BY created_at', [req.params.deviceId, req.user.id], (err, rules) => {
      if (err) return res.status(500).json({ error: 'Error fetching rules' });
      res.json(rules || []);
    });
  });
});

app.post('/api/devices/:deviceId/alert-rules', authenticateToken, (req, res) => {
  const { name, metric, operator, threshold } = req.body;
  if (!name || !metric || !operator || threshold === undefined) return res.status(400).json({ error: 'name, metric, operator, threshold required' });
  if (!['temperature', 'humidity', 'pressure'].includes(metric)) return res.status(400).json({ error: 'metric must be temperature, humidity, or pressure' });
  if (!['above', 'below'].includes(operator)) return res.status(400).json({ error: 'operator must be above or below' });
  const thresh = parseFloat(threshold);
  if (isNaN(thresh)) return res.status(400).json({ error: 'threshold must be a number' });

  db.get('SELECT device_id FROM devices WHERE device_id = ? AND user_id = ?', [req.params.deviceId, req.user.id], (err, dev) => {
    if (err || !dev) return res.status(404).json({ error: 'Device not found' });
    db.run('INSERT INTO alert_rules (user_id, device_id, name, metric, operator, threshold) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, req.params.deviceId, name, metric, operator, thresh],
      function(err) {
        if (err) return res.status(500).json({ error: 'Error creating rule' });
        res.status(201).json({ id: this.lastID, user_id: req.user.id, device_id: req.params.deviceId, name, metric, operator, threshold: thresh, enabled: 1 });
      }
    );
  });
});

app.patch('/api/alert-rules/:id', authenticateToken, (req, res) => {
  const { name, metric, operator, threshold, enabled } = req.body;
  db.get('SELECT * FROM alert_rules WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], (err, rule) => {
    if (err || !rule) return res.status(404).json({ error: 'Rule not found' });
    const updates = {
      name: name !== undefined ? name : rule.name,
      metric: metric !== undefined ? metric : rule.metric,
      operator: operator !== undefined ? operator : rule.operator,
      threshold: threshold !== undefined ? parseFloat(threshold) : rule.threshold,
      enabled: enabled !== undefined ? (enabled ? 1 : 0) : rule.enabled
    };
    db.run('UPDATE alert_rules SET name=?, metric=?, operator=?, threshold=?, enabled=? WHERE id=?',
      [updates.name, updates.metric, updates.operator, updates.threshold, updates.enabled, rule.id],
      (err) => { if (err) return res.status(500).json({ error: 'Error updating rule' }); res.json({ message: 'Rule updated', ...updates }); }
    );
  });
});

app.delete('/api/alert-rules/:id', authenticateToken, (req, res) => {
  db.run('DELETE FROM alert_rules WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], function(err) {
    if (err) return res.status(500).json({ error: 'Error deleting rule' });
    if (this.changes === 0) return res.status(404).json({ error: 'Rule not found' });
    res.json({ message: 'Rule deleted' });
  });
});

// ========== FIRMWARE UPDATE (US23) ==========

app.patch('/api/devices/:id/firmware', authenticateToken, (req, res) => {
  const { firmware_version } = req.body;
  if (!firmware_version || !String(firmware_version).trim()) return res.status(400).json({ error: 'firmware_version required' });
  const version = String(firmware_version).trim();
  db.get('SELECT * FROM devices WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], (err, dev) => {
    if (err || !dev) return res.status(404).json({ error: 'Device not found' });
    const prev = dev.firmware_version || '1.0.0';
    db.run('UPDATE devices SET firmware_version = ? WHERE id = ?', [version, dev.id], function(err) {
      if (err) return res.status(500).json({ error: 'Error updating firmware' });
      logAdminAction(req.user.id, 'FIRMWARE_UPDATE', null, JSON.stringify({ device_id: dev.device_id, device_name: dev.device_name, from: prev, to: version }), req.ip);
      res.json({ message: `Firmware updated from ${prev} to ${version}`, firmware_version: version });
    });
  });
});

// ========== EXPORT SCHEDULES (US25, US26) ==========

app.get('/api/export-schedules', authenticateToken, (req, res) => {
  db.all('SELECT * FROM export_schedules WHERE user_id = ? ORDER BY created_at', [req.user.id], (err, schedules) => {
    if (err) return res.status(500).json({ error: 'Error fetching schedules' });
    res.json(schedules || []);
  });
});

const computeNextRun = (frequency) => {
  const d = new Date();
  if (frequency === 'daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else d.setDate(d.getDate() + 30); // monthly
  d.setHours(8, 0, 0, 0);
  return d.toISOString();
};

app.post('/api/export-schedules', authenticateToken, (req, res) => {
  const { name, device_id, frequency, format } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  const freq = ['daily', 'weekly', 'monthly'].includes(frequency) ? frequency : 'weekly';
  const fmt = ['csv', 'json'].includes(format) ? format : 'csv';
  const next = computeNextRun(freq);

  const proceed = () => {
    db.run('INSERT INTO export_schedules (user_id, device_id, name, frequency, format, next_run) VALUES (?, ?, ?, ?, ?, ?)',
      [req.user.id, device_id || null, String(name).trim(), freq, fmt, next],
      function(err) {
        if (err) return res.status(500).json({ error: 'Error creating schedule' });
        res.status(201).json({ id: this.lastID, user_id: req.user.id, device_id: device_id || null, name, frequency: freq, format: fmt, enabled: 1, next_run: next });
      }
    );
  };

  if (device_id) {
    db.get('SELECT device_id FROM devices WHERE device_id = ? AND user_id = ?', [device_id, req.user.id], (err, dev) => {
      if (err || !dev) return res.status(404).json({ error: 'Device not found' });
      proceed();
    });
  } else {
    proceed();
  }
});

app.patch('/api/export-schedules/:id', authenticateToken, (req, res) => {
  const { name, frequency, format, enabled } = req.body;
  db.get('SELECT * FROM export_schedules WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], (err, sched) => {
    if (err || !sched) return res.status(404).json({ error: 'Schedule not found' });
    const freq = ['daily', 'weekly', 'monthly'].includes(frequency) ? frequency : sched.frequency;
    const next = frequency && frequency !== sched.frequency ? computeNextRun(freq) : sched.next_run;
    db.run('UPDATE export_schedules SET name=?, frequency=?, format=?, enabled=?, next_run=? WHERE id=?',
      [name || sched.name, freq, ['csv','json'].includes(format) ? format : sched.format, enabled !== undefined ? (enabled ? 1 : 0) : sched.enabled, next, sched.id],
      (err) => { if (err) return res.status(500).json({ error: 'Error updating schedule' }); res.json({ message: 'Schedule updated' }); }
    );
  });
});

app.delete('/api/export-schedules/:id', authenticateToken, (req, res) => {
  db.run('DELETE FROM export_schedules WHERE id = ? AND user_id = ?', [req.params.id, req.user.id], function(err) {
    if (err) return res.status(500).json({ error: 'Error deleting schedule' });
    if (this.changes === 0) return res.status(404).json({ error: 'Schedule not found' });
    res.json({ message: 'Schedule deleted' });
  });
});

// ========== SETUP ==========

app.post('/api/setup-admin', async (req, res) => {
  const { email, secret } = req.body;
  if (secret !== 'MAKE_ME_ADMIN_2024') return res.status(403).json({ error: 'Invalid secret' });
  db.run('UPDATE users SET is_admin = 1 WHERE email = ?', [email], function(err) {
    if (err) return res.status(500).json({ error: 'Error' });
    if (this.changes === 0) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'You are now an ADMIN!' });
  });
});

// ========== CLEANUP JOBS ==========

function runCleanupJob() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 2);
  db.run(
    "DELETE FROM users WHERE is_active = 0 AND disabled_by IS NULL AND disabled_at < ?",
    [cutoff.toISOString()],
    function(err) {
      if (err) console.error('Cleanup job error:', err);
      else if (this.changes > 0) console.log(`[Cleanup] Deleted ${this.changes} self-deactivated account(s) older than 2 months`);
    }
  );
}

function runRetentionJob() {
  db.all('SELECT id, retention_days FROM users WHERE retention_days IS NOT NULL AND retention_days > 0', [], (err, users) => {
    if (err) { console.error('Retention job error:', err); return; }
    users.forEach((u) => {
      const days = Math.min(3650, Math.max(1, u.retention_days || 365));
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      db.run(
        'DELETE FROM sensor_data WHERE device_id IN (SELECT device_id FROM devices WHERE user_id = ?) AND datetime(timestamp) < datetime(?)',
        [u.id, cutoff.toISOString()],
        function(delErr) {
          if (delErr) console.error('Retention delete error:', delErr);
          else if (this.changes > 0) console.log(`[Retention] Deleted ${this.changes} old readings for user ${u.id}`);
        }
      );
    });
  });
}

// ========== SCHEDULED EXPORT JOB (US25, US26) ==========

async function runExportSchedules() {
  if (!process.env.GMAIL_USER) return;
  const now = new Date().toISOString();
  db.all(`SELECT es.*, u.email, u.username FROM export_schedules es
    JOIN users u ON es.user_id = u.id
    WHERE es.enabled = 1 AND es.next_run IS NOT NULL AND datetime(es.next_run) <= datetime(?)`, [now], (err, schedules) => {
    if (err || !schedules || schedules.length === 0) return;
    schedules.forEach(sched => {
      const buildAndSend = (rows, deviceLabel) => {
        if (!rows || rows.length === 0) rows = [];
        let content, filename, mimeType;
        if (sched.format === 'csv') {
          content = 'timestamp,temperature,humidity,pressure\n' + rows.map(r => `${r.timestamp||''},${r.temperature??''},${r.humidity??''},${r.pressure??''}`).join('\n');
          filename = `export-${deviceLabel}-${new Date().toISOString().slice(0,10)}.csv`;
          mimeType = 'text/csv';
        } else {
          content = JSON.stringify(rows, null, 2);
          filename = `export-${deviceLabel}-${new Date().toISOString().slice(0,10)}.json`;
          mimeType = 'application/json';
        }
        const recipient = (sched.email && !sched.email.endsWith('@local.invalid')) ? sched.email : process.env.GMAIL_USER;
        mailer.sendMail({
          from: `"Sensor System" <${process.env.GMAIL_USER}>`,
          to: recipient,
          subject: `📊 Scheduled Export — ${sched.name}`,
          html: `<div style="font-family:sans-serif;padding:20px;"><h3>Scheduled Data Export</h3><p><strong>Schedule:</strong> ${sched.name}</p><p><strong>Frequency:</strong> ${sched.frequency}</p><p><strong>Device:</strong> ${deviceLabel}</p><p><strong>Records:</strong> ${rows.length}</p><p>See attached file for the exported data.</p></div>`,
          attachments: [{ filename, content, contentType: mimeType }]
        }).catch(e => console.error('Export email error:', e));
      };

      const next = computeNextRun(sched.frequency);
      db.run('UPDATE export_schedules SET last_run = ?, next_run = ? WHERE id = ?', [now, next, sched.id]);

      if (sched.device_id) {
        db.all('SELECT timestamp, temperature, humidity, pressure FROM sensor_data WHERE device_id = ? ORDER BY timestamp DESC LIMIT 5000', [sched.device_id], (err, rows) => {
          buildAndSend(rows, sched.device_id);
        });
      } else {
        // All devices for user (backup)
        db.all(`SELECT sd.timestamp, sd.temperature, sd.humidity, sd.pressure, d.device_name, d.device_id
          FROM sensor_data sd JOIN devices d ON sd.device_id = d.device_id
          WHERE d.user_id = ? ORDER BY sd.timestamp DESC LIMIT 10000`, [sched.user_id], (err, rows) => {
          buildAndSend(rows, 'all-devices');
        });
      }
    });
  });
}

runCleanupJob();
runRetentionJob();
runExportSchedules();
setInterval(runCleanupJob, 24 * 60 * 60 * 1000);
setInterval(runRetentionJob, 24 * 60 * 60 * 1000);
setInterval(runExportSchedules, 60 * 60 * 1000); // hourly check

// ========== START ==========

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop');
});