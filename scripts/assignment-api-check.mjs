/**
 * Automated API checks for Sensor Integration System (supports SIS test scripts TS-01–TS-16).
 * Starts the server briefly, runs checks, writes Test_Execution_Automated_Results.txt, exits.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outFile = path.join(root, 'Test_Execution_Automated_Results.txt');

function loadEnv() {
  const envPath = path.join(root, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (!m) continue;
    const k = m[1].trim();
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnv();
const PORT = parseInt(process.env.PORT || '3001', 10);
const base = `http://127.0.0.1:${PORT}`;

function request(method, urlPath, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, base);
    const h = { ...headers };
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' ? body : JSON.stringify(body);
      if (!h['Content-Type'] && !h['content-type']) h['Content-Type'] = 'application/json';
    }
    const opts = { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers: h };
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(raw);
        } catch {
          /* leave json null */
        }
        resolve({ status: res.statusCode, headers: res.headers, raw, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function waitForServer(maxMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const r = await request('GET', '/');
      if (r.status === 200) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Server did not become ready in time');
}

function line(s) {
  return s + '\n';
}

async function main() {
  const lines = [];
  const stamp = new Date().toISOString();
  lines.push(line('Sensor Integration System — Automated API verification'));
  lines.push(line(`Generated: ${stamp}`));
  lines.push(line(`Base URL: ${base}`));
  lines.push(line('—'.repeat(60)));

  const server = spawn('node', [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stderr.on('data', (d) => {
    serverLog += d.toString();
  });
  server.stdout.on('data', (d) => {
    serverLog += d.toString();
  });

  const results = [];

  function record(id, ok, detail) {
    const status = ok ? 'PASS' : 'FAIL';
    results.push({ id, status, detail });
    lines.push(line(`[${status}] ${id}${detail ? ` — ${detail}` : ''}`));
  }

  try {
    await waitForServer();

    // TS-02 / auth: no token
    let r = await request('GET', '/api/devices');
    record('TS-02 / no Authorization', r.status === 401 && r.json?.error?.includes('token'), `HTTP ${r.status}`);

    // TS-02 / bad token
    r = await request('GET', '/api/devices', { headers: { Authorization: 'Bearer invalid-token-xyz' } });
    record('TS-02 / invalid JWT', r.status === 403, `HTTP ${r.status}`);

    // TS-01 weak password
    const suffix = Date.now();
    const uName = `auto_${suffix}`;
    const email = `auto_${suffix}@example.com`;
    r = await request('POST', '/api/auth/register', {
      body: { username: uName, identifier: email, identifierType: 'email', password: 'weak' },
    });
    record('TS-01 / weak password rejected', r.status === 400, `HTTP ${r.status}`);

    // TS-01 valid register
    const pass = 'Test1234!';
    r = await request('POST', '/api/auth/register', {
      body: { username: uName, identifier: email, identifierType: 'email', password: pass },
    });
    const userToken = r.json?.token;
    record('TS-01 / register success', r.status === 201 && userToken, `HTTP ${r.status}`);

    // TS-02 wrong password
    r = await request('POST', '/api/auth/login', {
      body: { identifier: email, identifierType: 'email', password: 'Wrong1!' },
    });
    record('TS-02 / wrong password 401', r.status === 401, `HTTP ${r.status}`);

    // TS-02 lockout: 1 failure above + 4 more = 5th failure locks account
    for (let i = 0; i < 4; i++) {
      r = await request('POST', '/api/auth/login', {
        body: { identifier: email, identifierType: 'email', password: 'Wrong1!' },
      });
    }
    record('TS-02 / lockout after failures', r.status === 403 && r.json?.locked, `HTTP ${r.status}`);

    // Admin unlock
    r = await request('POST', '/api/auth/login', {
      body: { identifier: 'admin@system.local', identifierType: 'email', password: 'Admin123!' },
    });
    const adminToken = r.json?.token;
    record('TS-12 / admin login', r.status === 200 && adminToken, `HTTP ${r.status}`);

    r = await request('GET', '/api/admin/users', { headers: { Authorization: `Bearer ${adminToken}` } });
    const userList = Array.isArray(r.json) ? r.json : [];
    const lockedUser = userList.find((u) => u.username === uName);
    const lockedId = lockedUser?.id;
    record('TS-12 / find locked user', !!lockedId, lockedId ? `id=${lockedId}` : 'not found');

    if (lockedId) {
      r = await request('PATCH', `/api/admin/users/${lockedId}/unlock`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      record('TS-12 / unlock', r.status === 200, `HTTP ${r.status}`);
    }

    r = await request('POST', '/api/auth/login', {
      body: { identifier: email, identifierType: 'email', password: pass },
    });
    const token2 = r.json?.token;
    record('TS-02 / login after unlock', r.status === 200 && token2, `HTTP ${r.status}`);

    const token = token2 || userToken;

    // TS-07 device
    const devId = `DEV-AUTO-${suffix}`;
    r = await request('POST', '/api/devices', {
      headers: { Authorization: `Bearer ${token}` },
      body: { device_name: 'Auto Device', device_type: 'Temperature', device_id: devId },
    });
    record('TS-07 / add device', r.status === 201, `HTTP ${r.status}`);

    r = await request('POST', `/api/demo/generate-data/${devId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    record('TS-08 / generate data', r.status === 200 && r.json?.temperature != null, `HTTP ${r.status}`);

    r = await request('GET', `/api/sensor-data/${devId}?limit=5`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    record('TS-09 / sensor list limit', r.status === 200 && Array.isArray(r.json) && r.json.length <= 5, `count=${r.json?.length}`);

    r = await request('GET', `/api/sensor-data/${devId}/export?format=csv&limit=2`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const csvLines = (r.raw || '').split('\n').filter(Boolean);
    record('TS-10 / CSV export limit=2', r.status === 200 && csvLines.length <= 3, `lines=${csvLines.length}`);

    r = await request('GET', `/api/sensor-data/${devId}/export?format=json&limit=2`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const arr = r.json;
    record('TS-10 / JSON export', r.status === 200 && Array.isArray(arr) && arr.length <= 2, `len=${arr?.length}`);

    // TS-14 admin routes as user
    r = await request('GET', '/api/admin/users', { headers: { Authorization: `Bearer ${token}` } });
    record('TS-14 / user blocked from admin', r.status === 403, `HTTP ${r.status}`);

    // TS-04 change password
    const newPass = 'NewPass99@';
    r = await request('POST', '/api/account/change-password', {
      headers: { Authorization: `Bearer ${token}` },
      body: { newPassword: newPass },
    });
    record('TS-04 / change password API', r.status === 200, `HTTP ${r.status}`);

    r = await request('POST', '/api/auth/login', {
      body: { identifier: email, identifierType: 'email', password: pass },
    });
    record('TS-04 / old password invalid', r.status === 401, `HTTP ${r.status}`);

    r = await request('POST', '/api/auth/login', {
      body: { identifier: email, identifierType: 'email', password: newPass },
    });
    const token3 = r.json?.token;
    record('TS-04 / new password login', r.status === 200 && token3, `HTTP ${r.status}`);

    // TS-05 PATCH account
    r = await request('PATCH', '/api/account', {
      headers: { Authorization: `Bearer ${token3}` },
      body: { retention_days: 30, alert_on_failed_login: false },
    });
    record('TS-05 / PATCH account', r.status === 200 && r.json?.message?.includes('updated'), `HTTP ${r.status}`);

    // TS-03 forgot non-existent
    r = await request('POST', '/api/auth/forgot-password', {
      body: { identifier: 'nobody-forgot@example.com' },
    });
    record('TS-03 / forgot unknown 404', r.status === 404, `HTTP ${r.status}`);

    lines.push(line('—'.repeat(60)));
    const failed = results.filter((x) => x.status === 'FAIL');
    lines.push(line(`Summary: ${results.length - failed.length}/${results.length} checks passed.`));
    if (failed.length) {
      lines.push(line('Failed:'));
      failed.forEach((f) => lines.push(line(`  - ${f.id}: ${f.detail || ''}`)));
    }
    lines.push(line(''));
    lines.push(line('Manual steps (mark in SIS_Test_Scripts_v1.0.docx):'));
    lines.push(line('  TS-01 steps 1–2,7–8: UI registration flow and validation messages'));
    lines.push(line('  TS-03 steps 1–3: Gmail / forgot-password email (optional if no mail)'));
    lines.push(line('  TS-06, TS-11: self-deactivate UI; threshold alert email'));
    lines.push(line('  TS-07: QR scan, cross-user device isolation in browser'));
    lines.push(line('  TS-08 step 2: wait 6 minutes for offline badge'));
    lines.push(line('  TS-15 step 5: expired JWT (24h) or tampered exp'));
    lines.push(line('  TS-16: DB manipulation + job triggers as in test script'));
  } catch (e) {
    lines.push(line(`FATAL: ${e.message}`));
    if (serverLog) lines.push(line('--- server log (tail) ---\n' + serverLog.slice(-2000)));
  } finally {
    server.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
  }

  fs.writeFileSync(outFile, lines.join(''), 'utf8');
  console.log(`Wrote ${outFile}`);
  const failed = results.filter((x) => x.status === 'FAIL');
  process.exit(failed.length ? 1 : 0);
}

main();
