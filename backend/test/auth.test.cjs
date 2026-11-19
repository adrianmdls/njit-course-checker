const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const express = require('express');
const mysql = require('mysql2/promise');
const createAuth = require('../src/auth');
const createCourses = require('../src/courses');

// Apply real HTTP Set-Cookie headers in arrival order, including deletion.
class CookieJar {
  cookie = '';
  accept(response) {
    for (const value of response.headers.getSetCookie()) {
      assert.match(value, /^njit\.sid=/);
      this.cookie = /Expires=Thu, 01 Jan 1970/.test(value) ? '' : value.split(';')[0];
    }
    return response;
  }
}

test('MariaDB auth cookies survive reordered restoration/login responses and retain security/expiration',
  { skip: !process.env.TEST_DB_PORT && 'Set TEST_DB_PORT to a disposable MariaDB server only', timeout: 30000 }, async t => {
    const database = `auth_cookie_test_${randomBytes(6).toString('hex')}`;
    const config = { host: process.env.TEST_DB_HOST || '127.0.0.1', port: Number(process.env.TEST_DB_PORT),
      user: 'root', password: process.env.TEST_DB_PASSWORD || 'test-only-password' };
    const admin = await mysql.createConnection(config);
    const pool = mysql.createPool({ ...config, database, connectionLimit: 5, multipleStatements: true });
    let auth, server, gate;
    const releases = [];
    let owned = false;
    // Pause after the actual DB read/delete: the request has already restored
    // the old session, while a concurrent login can regenerate and save its ID.
    function delayNext(operation, matches) {
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      releases.push(release.resolve);
      gate = { operation, matches, entered, release };
      return { entered: entered.promise, release: release.resolve };
    }
    const wrapped = Object.fromEntries(['query', 'execute'].map(operation => [operation, async (...args) => {
      const current = gate?.operation === operation && gate.matches(args[0]) ? gate : null;
      if (current) gate = null;
      const result = await pool[operation](...args);
      if (current) {
        current.entered.resolve();
        await current.release.promise;
      }
      return result;
    }]));
    const userRead = () => delayNext('execute', sql => sql.includes('FROM Users WHERE id = ?'));
    const credentials = { username: 'cookie_watcher', email: 'cookies@example.invalid',
      password: 'cookie-regression-only-password' };
    try {
      await admin.query(`CREATE DATABASE ${database}`); owned = true;
      const schema = await readFile(`${__dirname}/../../database/init/01-schema.sql`, 'utf8');
      await pool.query(schema.replace('USE njit_course_checker;', `USE ${database};`));
      process.env.APP_ENV = 'development';
      process.env.APP_ORIGIN = 'http://localhost:8080';
      process.env.SESSION_SECRET = 'auth-cookie-regression-secret-at-least-32-bytes';
      auth = await createAuth(wrapped);
      const app = express();
      app.use('/api/auth', auth.router);
      app.use('/api/courses', createCourses(wrapped, auth));
      app.use((error, req, res, _next) => res.status(500).json({ error: 'Test request failed' }));
      server = await new Promise((resolve, reject) => {
        const listener = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(listener));
      });
      const origin = `http://127.0.0.1:${server.address().port}`;
      const request = (path, cookie = '', body, headers = {}, method = body === undefined ? 'GET' : 'POST') => {
        const options = { method, headers: { Cookie: cookie,
          ...(body === undefined ? {} : { Origin: process.env.APP_ORIGIN,
            'X-Requested-With': 'NJIT-Course-Checker', 'Content-Type': 'application/json' }), ...headers },
        signal: AbortSignal.timeout(10000) };
        if (body !== undefined) options.body = JSON.stringify(body);
        return fetch(`${origin}/api/${path}`, options);
      };
      const login = cookie => request('auth/login', cookie, { identifier: credentials.username, password: credentials.password });
      const sessions = async () => (await pool.query('SELECT session_id, expires, data FROM sessions'))[0];
      const jar = new CookieJar();

      await t.test('normal login issues a signed protected cookie; anonymous restoration issues none', async () => {
        const anonymous = await request('auth/me');
        assert.equal(anonymous.status, 401);
        assert.deepEqual(anonymous.headers.getSetCookie(), []);
        assert.equal((await request('auth/register', '', credentials)).status, 201);
        const response = jar.accept(await login());
        assert.equal(response.status, 200);
        assert.match(jar.cookie, /^njit\.sid=s%3A/);
        const header = response.headers.get('set-cookie');
        assert.match(header, /; HttpOnly/);
        assert.match(header, /; SameSite=Lax/);
        assert.match(header, /; Path=\//);
        assert.doesNotMatch(header, /Domain=/);
        const expires = Date.parse(/Expires=([^;]+)/.exec(header)[1]);
        assert.ok(Math.abs(expires - Date.now() - 30 * 60000) < 5000);
      });

      for (const order of ['login-first', 'restoration-first']) {
        await t.test(`${order}: delayed restoration never replaces the regenerated cookie`, async () => {
          const oldCookie = jar.cookie;
          const oldId = (await sessions())[0].session_id;
          const delayed = userRead();
          const restoration = request('auth/me?restore=1', oldCookie);
          await delayed.entered;
          let restored;
          if (order === 'restoration-first') {
            delayed.release();
            restored = jar.accept(await restoration);
          }
          const response = jar.accept(await login(oldCookie));
          assert.equal(response.status, 200);
          const newCookie = jar.cookie;
          assert.notEqual(newCookie, oldCookie, 'login must regenerate the session ID');
          assert.equal((await request('auth/me', newCookie)).status, 200);
          assert.ok(!(await sessions()).some(row => row.session_id === oldId), 'old session is destroyed');
          if (order === 'login-first') {
            delayed.release();
            restored = jar.accept(await restoration);
          }
          assert.equal(restored.status, 200);
          assert.deepEqual(restored.headers.getSetCookie(), [], 'restoration must not write any session cookie');
          assert.equal(jar.cookie, newCookie);
          const final = jar.accept(await request('courses/options', jar.cookie));
          assert.equal(final.status, 200, 'the last browser cookie belongs to the authenticated session');
          assert.equal(jar.cookie, newCookie);
          assert.equal((await request('auth/me', oldCookie)).status, 401);
        });
      }

      await t.test('GET/HEAD restoration works without cookies; normal API activity renews idle expiration', async () => {
        const [before] = await sessions();
        const data = JSON.parse(before.data);
        const shortly = Date.now() + 60000;
        data.cookie.expires = new Date(shortly).toISOString();
        await pool.query('UPDATE sessions SET expires=?, data=?', [Math.round(shortly / 1000), JSON.stringify(data)]);
        for (const [method, path] of [['GET', 'auth/me'], ['HEAD', 'auth/me'], ['GET', 'auth/ME/']]) {
          const response = await request(path, jar.cookie, undefined, {}, method);
          assert.equal(response.status, 200);
          assert.deepEqual(response.headers.getSetCookie(), []);
        }
        const renewed = jar.accept(await request('courses/options', jar.cookie));
        assert.equal(renewed.status, 200);
        const expires = Date.parse(/Expires=([^;]+)/.exec(renewed.headers.get('set-cookie'))[1]);
        assert.ok(Math.abs(expires - Date.now() - 30 * 60000) < 5000);
        const [after] = await sessions();
        assert.equal(after.session_id, before.session_id);
        assert.ok(Math.abs(after.expires * 1000 - Date.now() - 30 * 60000) < 5000);
        assert.equal(JSON.parse(after.data).authenticatedAt, data.authenticatedAt, 'rolling renewal does not reset authentication age');
      });

      await t.test('delayed absolute-expiry restoration cannot clear a newer login cookie', async () => {
        await pool.query('UPDATE sessions SET data=JSON_SET(data, "$.authenticatedAt", ?)', [Date.now() - 8 * 3600000]);
        const delayed = delayNext('query', sql => sql.startsWith('DELETE FROM ??'));
        const restoration = request('auth/me', jar.cookie);
        await delayed.entered;
        const response = jar.accept(await login(jar.cookie));
        assert.equal(response.status, 200);
        const newCookie = jar.cookie;
        delayed.release();
        const expired = jar.accept(await restoration);
        assert.equal(expired.status, 401);
        assert.deepEqual(expired.headers.getSetCookie(), []);
        assert.equal(jar.cookie, newCookie);
        assert.equal((await request('auth/me', jar.cookie)).status, 200);
      });

      await t.test('logout clears the cookie/store and delayed restoration cannot restore it', async () => {
        const oldCookie = jar.cookie;
        const delayed = userRead();
        const restoration = request('auth/me', oldCookie);
        await delayed.entered;
        const logout = jar.accept(await request('auth/logout', oldCookie, {}));
        assert.equal(logout.status, 204);
        assert.equal(jar.cookie, '');
        delayed.release();
        const restored = jar.accept(await restoration);
        assert.deepEqual(restored.headers.getSetCookie(), []);
        assert.equal(jar.cookie, '');
        assert.deepEqual(await sessions(), []);
        assert.equal((await request('auth/me', oldCookie)).status, 401);
      });

      await t.test('idle and absolute expiration still reject old sessions', async () => {
        jar.accept(await login());
        await pool.query('UPDATE sessions SET expires=1');
        const idle = await request('auth/me', jar.cookie);
        assert.equal(idle.status, 401);
        assert.deepEqual(idle.headers.getSetCookie(), []);
        await pool.query('DELETE FROM sessions');
        jar.accept(await login());
        await pool.query('UPDATE sessions SET data=JSON_SET(data, "$.authenticatedAt", ?)', [Date.now() - 8 * 3600000]);
        const expired = jar.accept(await request('courses/options', jar.cookie));
        assert.equal(expired.status, 401);
        assert.equal(jar.cookie, '');
        assert.deepEqual(await sessions(), []);
      });

      await t.test('login/logout retain exact-Origin, custom-header and JSON protections', async () => {
        jar.accept(await login());
        const before = jar.cookie;
        for (const path of ['auth/login', 'auth/logout']) {
          for (const headers of [{ Origin: 'https://evil.invalid' }, { 'X-Requested-With': '' }]) {
            assert.equal((await request(path, jar.cookie, {}, headers)).status, 403);
          }
          assert.equal((await request(path, jar.cookie, {}, { 'Content-Type': 'text/plain' })).status, 415);
        }
        assert.equal(jar.cookie, before);
        assert.equal((await request('auth/me', jar.cookie)).status, 200);
      });
    } finally {
      for (const release of releases) release();
      if (server) await new Promise(resolve => server.close(resolve));
      if (auth) await auth.close();
      await pool.end();
      if (owned) await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  });
