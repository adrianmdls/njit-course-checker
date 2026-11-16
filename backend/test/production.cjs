// Run inside the backend container: node < backend/test/production.cjs
const assert = require('node:assert/strict');
const express = require('express');
const argon2 = require('argon2');
const pool = require('./src/db');
const createAuth = require('./src/auth');
(async () => {
  const username = `production_test_${Date.now()}`;
  let auth, server;
  try {
    process.env.APP_ENV = 'production';
    process.env.APP_ORIGIN = 'http://example.invalid';
    await assert.rejects(createAuth(pool), /HTTPS/);
    process.env.APP_ORIGIN = 'https://example.invalid';
    const secret = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'short';
    await assert.rejects(createAuth(pool), /SESSION_SECRET/);
    process.env.SESSION_SECRET = secret;
    auth = await createAuth(pool);
    const app = express();
    app.set('trust proxy', 1);
    app.use('/api/auth', auth.router);
    server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const url = `http://127.0.0.1:${server.address().port}/api/auth`;
    assert.equal((await fetch(`${url}/me`)).status, 400);
    const password = 'Production test password 981!';
    await pool.execute('INSERT INTO Users (username,email,password_hash) VALUES (?,?,?)', [username, `${username}@example.invalid`, await argon2.hash(password)]);
    const response = await fetch(`${url}/login`, { method: 'POST', headers: {
      'X-Forwarded-Proto': 'https', Origin: process.env.APP_ORIGIN,
      'X-Requested-With': 'NJIT-Course-Checker', 'Content-Type': 'application/json',
    }, body: JSON.stringify({ identifier: username, password }) });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /^__Host-njit.sid=/);
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; HttpOnly/);
    assert.match(cookie, /; SameSite=Lax/);
    assert.doesNotMatch(cookie, /Domain=/);
    console.log('PASS: production rejects HTTP/insecure configuration; HTTPS proxy login sets secure host-only HttpOnly SameSite cookie');
  } finally {
    await pool.execute('DELETE FROM sessions WHERE JSON_EXTRACT(data, "$.userId")=(SELECT id FROM Users WHERE username=?)', [username]);
    await pool.execute('DELETE FROM Users WHERE username=?', [username]);
    if (server) await new Promise(resolve => server.close(resolve));
    if (auth) await auth.close();
    await pool.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
