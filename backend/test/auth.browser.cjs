// Run from repository root with Playwright available through NODE_PATH.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const origin = process.env.TEST_ORIGIN || 'http://localhost:8080';
const username = `auth_test_${Date.now()}`;
const password = 'Integration test password 938!';
const email = `${username}@example.invalid`;
function sql(statement, params) {
  const code = `const p=require('./src/db'); p.execute(${JSON.stringify(statement)},${JSON.stringify(params)}).then(([r])=>console.log(JSON.stringify(r))).finally(()=>p.end());`;
  return JSON.parse(execFileSync('docker', ['compose', 'exec', '-T', 'backend', 'node', '-e', code], { encoding: 'utf8' }));
}
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const post = (route, data, headers = {}) => context.request.post(`${origin}/api/auth/${route}`, {
    data, headers: { Origin: origin, 'X-Requested-With': 'NJIT-Course-Checker', ...headers },
  });
  try {
    await page.goto(`${origin}/dashboard`);
    await page.waitForURL('**/login');
    assert.equal((await context.request.get(`${origin}/api/auth/me`)).status(), 401);
    assert.equal((await post('register', {}, { Origin: 'https://evil.invalid' })).status(), 403);
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: {} })).status(), 403);
    assert.equal((await post('register', { username, email, password: 'short' })).status(), 400);
    await page.goto(`${origin}/register`);
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByLabel('Confirm Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.waitForURL('**/login');
    assert.match(await page.getByRole('status').textContent(), /Account created/);
    const [user] = sql('SELECT password_hash, email_verified FROM Users WHERE username=?', [username]);
    assert.match(user.password_hash, /^\$argon2id\$/);
    assert.equal(user.email_verified, 0);
    assert.equal((await post('register', { username, email, password })).status(), 409);
    assert.equal((await post('login', { identifier: username, password: 'wrong password' })).status(), 401);
    await page.getByLabel('Username / Email').fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Login', exact: true }).click();
    await page.waitForURL('**/dashboard');
    const firstCookie = (await context.cookies()).find(c => c.name === 'njit.sid');
    assert.ok(firstCookie.httpOnly);
    assert.equal(firstCookie.sameSite, 'Lax');
    assert.equal(firstCookie.secure, false);
    assert.equal((await context.request.get(`${origin}/api/auth/me`)).status(), 200);
    const firstSession = sql('SELECT session_id FROM sessions WHERE JSON_EXTRACT(data, "$.userId")=(SELECT id FROM Users WHERE username=?)', [username])[0].session_id;
    assert.equal((await post('login', { identifier: username, password })).status(), 200);
    assert.notEqual((await context.cookies()).find(c => c.name === 'njit.sid').value, firstCookie.value);
    assert.equal(sql('SELECT session_id FROM sessions WHERE session_id=?', [firstSession]).length, 0);
    execFileSync('docker', ['compose', 'restart', 'backend'], { stdio: 'pipe' });
    // Docker restart returns before the process starts accepting connections.
    for (let i = 0; i < 40; i++) {
      const r = await context.request.get(`${origin}/api/auth/me`);
      if (r.status() === 200) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.equal((await context.request.get(`${origin}/api/auth/me`)).status(), 200);
    try {
      execFileSync('docker', ['compose', 'stop', 'db'], { stdio: 'pipe' });
      assert.equal((await context.request.get(`${origin}/api/auth/me`)).status(), 503);
      assert.equal((await context.request.get(`${origin}/api/health`)).status(), 503);
    } finally {
      execFileSync('docker', ['compose', 'start', '--wait', 'db'], { stdio: 'pipe' });
    }
    assert.equal((await context.request.get(`${origin}/api/auth/me`)).status(), 200);
    await page.reload();
    await page.getByRole('button', { name: 'Logout', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Logout', exact: true }).click();
    await page.waitForURL('**/login');
    assert.equal((await context.request.get(`${origin}/api/auth/me`)).status(), 401);
    assert.equal(sql('SELECT session_id FROM sessions WHERE JSON_EXTRACT(data, "$.userId")=(SELECT id FROM Users WHERE username=?)', [username]).length, 0);
    await post('login', { identifier: username, password });
    sql('UPDATE sessions SET data=JSON_SET(data, "$.authenticatedAt", ?) WHERE JSON_EXTRACT(data, "$.userId")=(SELECT id FROM Users WHERE username=?)', [Date.now() - 9 * 3600000, username]);
    assert.equal((await context.request.get(`${origin}/api/auth/me`)).status(), 401);
    await post('login', { identifier: username, password });
    sql('UPDATE sessions SET expires=1 WHERE JSON_EXTRACT(data, "$.userId")=(SELECT id FROM Users WHERE username=?)', [username]);
    assert.equal((await context.request.get(`${origin}/api/auth/me`)).status(), 401);
    let limited = false;
    for (let i = 0; i < 11; i++) {
      if ((await post('login', { identifier: username, password: 'bad' })).status() === 429) { limited = true; break; }
    }
    assert.ok(limited);
    assert.deepEqual(errors, []);
    console.log('PASS: browser registration/login/logout, protected routes, Argon2id, duplicate/invalid input, CSRF, cookie flags, session regeneration/restart persistence, idle/absolute expiry, database outage/recovery, rate limiting, no browser errors');
  } finally {
    sql('DELETE FROM sessions WHERE JSON_EXTRACT(data, "$.userId")=(SELECT id FROM Users WHERE username=?)', [username]);
    sql('DELETE FROM Users WHERE username=? AND email=?', [username, email]);
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
