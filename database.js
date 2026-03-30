const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const bcrypt = require("bcrypt");

const db = new sqlite3.Database(
  path.join(__dirname, "sensor_system.db"),
  (err) => {
    if (err) {
      console.error("Error connecting to database:", err);
    } else {
      console.log("Connected to SQLite database");
    }
  },
);

/* ============================================================
   CREATE SUPER ADMIN AUTOMATICALLY
============================================================ */

async function createSuperAdmin() {
  const email = "admin@system.local";
  const username = "superadmin";
  const password = "Admin123!";

  db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
    if (err) {
      console.error("Super admin check error:", err);
      return;
    }

    if (!user) {
      try {
        const hashedPassword = await bcrypt.hash(password, 10);

        db.run(
          `INSERT INTO users
            (username, email, password, is_admin, is_super_admin, is_active)
            VALUES (?, ?, ?, 1, 1, 1)`,

          [username, email, hashedPassword],

          (err) => {
            if (err) {
              console.error("Error creating super admin:", err);
            } else {
              console.log("=================================");
              console.log("SUPER ADMIN CREATED");
              console.log("Email:", email);
              console.log("Password:", password);
              console.log("=================================");
            }
          },
        );
      } catch (error) {
        console.error("Hash error:", error);
      }
    } else {
      console.log("Super admin already exists");
    }
  });
}

/* ============================================================
   CREATE TABLES
============================================================ */

db.serialize(() => {
  /* ================= USERS TABLE ================= */

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  /* ===== Additional Columns ===== */

  db.run(
    `ALTER TABLE users ADD COLUMN failed_attempts INTEGER DEFAULT 0`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.error(err.message);
      }
    },
  );

  db.run(`ALTER TABLE users ADD COLUMN phone TEXT`, (err) => {
    if (err && !err.message.includes("duplicate column")) {
      console.error(err.message);
    }
  });

  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone)`);

  db.run(`ALTER TABLE users ADD COLUMN is_locked INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes("duplicate column")) {
      console.error(err.message);
    }
  });

  /* ===== Admin System ===== */

  db.run(`ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0`, (err) => {
    if (err && !err.message.includes("duplicate column")) {
      console.error(err.message);
    }
  });

  db.run(
    `ALTER TABLE users ADD COLUMN is_super_admin INTEGER DEFAULT 0`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.error(err.message);
      }
    },
  );

  db.run(`ALTER TABLE users ADD COLUMN is_active INTEGER DEFAULT 1`, (err) => {
    if (err && !err.message.includes("duplicate column")) {
      console.error(err.message);
    }
  });

  db.run(`ALTER TABLE users ADD COLUMN last_login DATETIME`, (err) => {
    if (err && !err.message.includes("duplicate column")) {
      console.error(err.message);
    }
  });

  db.run(`ALTER TABLE users ADD COLUMN disabled_at DATETIME`, (err) => {
    if (err && !err.message.includes("duplicate column")) {
      console.error(err.message);
    }
  });

  db.run(`ALTER TABLE users ADD COLUMN disabled_by INTEGER`, (err) => {
    if (err && !err.message.includes("duplicate column")) {
      console.error(err.message);
    }
  });
  db.run(
    `ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0`,
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.error(err.message);
      }
    },
  );

  db.run(`ALTER TABLE users ADD COLUMN retention_days INTEGER DEFAULT 365`, (err) => {
    if (err && !err.message.includes("duplicate column")) console.error(err.message);
  });
  db.run(`ALTER TABLE users ADD COLUMN alert_on_failed_login INTEGER DEFAULT 1`, (err) => {
    if (err && !err.message.includes("duplicate column")) console.error(err.message);
  });

  /* ================= DEVICES TABLE ================= */

  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      device_name TEXT NOT NULL,
      device_type TEXT NOT NULL,
      device_id TEXT UNIQUE NOT NULL,
      status TEXT DEFAULT 'offline',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`ALTER TABLE devices ADD COLUMN last_seen_at DATETIME`, (err) => {
    if (err && !err.message.includes("duplicate column")) console.error(err.message);
  });
  db.run(`ALTER TABLE devices ADD COLUMN collection_interval_minutes INTEGER DEFAULT 10`, (err) => {
    if (err && !err.message.includes("duplicate column")) console.error(err.message);
  });
  db.run(`ALTER TABLE devices ADD COLUMN min_temperature REAL`, (err) => {
    if (err && !err.message.includes("duplicate column")) console.error(err.message);
  });
  db.run(`ALTER TABLE devices ADD COLUMN max_temperature REAL`, (err) => {
    if (err && !err.message.includes("duplicate column")) console.error(err.message);
  });
  db.run(`ALTER TABLE devices ADD COLUMN min_humidity REAL`, (err) => {
    if (err && !err.message.includes("duplicate column")) console.error(err.message);
  });
  db.run(`ALTER TABLE devices ADD COLUMN max_humidity REAL`, (err) => {
    if (err && !err.message.includes("duplicate column")) console.error(err.message);
  });
  db.run(`ALTER TABLE devices ADD COLUMN min_pressure REAL`, (err) => {
    if (err && !err.message.includes("duplicate column")) console.error(err.message);
  });
  db.run(`ALTER TABLE devices ADD COLUMN max_pressure REAL`, (err) => {
    if (err && !err.message.includes("duplicate column")) console.error(err.message);
  });

  /* ================= SENSOR DATA ================= */

  db.run(`
    CREATE TABLE IF NOT EXISTS sensor_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL,
      temperature REAL,
      humidity REAL,
      pressure REAL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
    )
  `);

  /* ================= ACTIVITY LOGS ================= */

  db.run(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      target_user_id INTEGER,
      details TEXT,
      ip_address TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
      FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  /* ================= CREATE SUPER ADMIN ================= */

  createSuperAdmin();
});

/* ============================================================
   DATABASE CONFIG
============================================================ */

db.run("PRAGMA foreign_keys = ON");
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA synchronous = NORMAL");

module.exports = db;
