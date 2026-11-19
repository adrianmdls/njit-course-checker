const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomBytes } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const express = require('express');
const mysql = require('mysql2/promise');
const createAuth = require('../src/auth');
const createWatchlist = require('../src/watchlist');
const createCourses = require('../src/courses');
const createSync = require('../src/department-sync');

const secret = 'watchlist-test-session-secret-at-least-32-bytes';
const token = 'watchlist-checker-test-token';
const user = { id: 1, username: 'watcher', email: 'watcher@example.invalid', email_verified: 0 };
const signedCookie = id => `njit.sid=${encodeURIComponent(`s:${id}.${createHmac('sha256', secret).update(id).digest('base64').replace(/=+$/, '')}`)}`;
const validCookie = signedCookie('valid-session');

// Exercise the real session and user middleware; fake only the SQL responses.
function fakePool(execute = async () => { throw new Error('Watchlist SQL must not run'); }) {
  return {
    async query(sql, params) {
      if (sql.startsWith('SELECT ??')) {
        const id = params[4];
        if (!['valid-session', 'expired-session', 'deleted-user'].includes(id)) return [[]];
        return [[{ expires: Math.floor(Date.now() / 1000) + 1800,
          data: JSON.stringify({ cookie: { maxAge: 1800000, path: '/' },
            userId: id === 'deleted-user' ? 2 : 1,
            authenticatedAt: Date.now() - (id === 'expired-session' ? 9 * 3600000 : 0) }) }]];
      }
      return [[]];
    },
    execute: (sql, values) => sql.includes('FROM Users') ? Promise.resolve([values[0] === 1 ? [user] : []]) : execute(sql, values),
  };
}

async function serve(pool, environment = 'development') {
  process.env.APP_ENV = environment;
  process.env.APP_ORIGIN = environment === 'production' ? 'https://example.invalid' : 'http://localhost:8080';
  process.env.SESSION_SECRET = secret;
  process.env.CHECKER_MONITORING_TARGETS = '[]';
  const auth = await createAuth(pool);
  const app = express();
  app.use('/api/auth', auth.router);
  app.use('/api/watchlist', createWatchlist(pool, auth));
  app.use('/api/courses', createCourses(pool, auth));
  app.use('/api/internal/sync', createSync(pool, token));
  app.use((error, req, res, next) => {
    const databaseError = /^(ER_|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|PROTOCOL_)/.test(error.code || '') || error.message === 'Queue limit reached.';
    const status = error.type === 'entity.parse.failed' ? 400 : error.type === 'entity.too.large' ? 413 : databaseError ? 503 : 500;
    res.status(status).json({ error: status === 503 ? 'Service temporarily unavailable' : 'Request failed' });
  });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    request: (method = 'GET', path = '/api/watchlist', body, cookie = validCookie, headers = {}) => fetch(`${base}${path}`, {
      method, headers: { Cookie: cookie, Origin: process.env.APP_ORIGIN,
        'X-Requested-With': 'NJIT-Course-Checker', 'Content-Type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    }),
    targets: async () => (await fetch(`${base}/api/internal/sync/targets?watched_only=true`, {
      headers: { Authorization: `Bearer ${token}` },
    })).json(),
    async close() {
      await new Promise(resolve => server.close(resolve));
      await auth.close();
    },
  };
}

test('watchlists require a real current session for every method', async () => {
  const api = await serve(fakePool());
  try {
    for (const cookie of ['', 'njit.sid=invalid', signedCookie('missing'), signedCookie('expired-session'), signedCookie('deleted-user')]) {
      for (const [method, path, body] of [['GET', '/api/watchlist'], ['POST', '/api/watchlist', { section_id: 11 }], ['DELETE', '/api/watchlist/11', {}]]) {
        const response = await api.request(method, path, body, cookie, { Authorization: `Bearer ${token}` });
        assert.equal(response.status, 401, `${method} ${cookie}`);
        assert.equal(response.headers.get('cache-control'), 'no-store');
      }
    }
  } finally { await api.close(); }
});

test('watchlist mutations retain the auth API origin/header/JSON protections', async () => {
  const api = await serve(fakePool());
  try {
    for (const method of ['POST', 'DELETE']) {
      const path = method === 'POST' ? '/api/watchlist' : '/api/watchlist/11';
      const body = method === 'POST' ? { section_id: 11 } : {};
      for (const headers of [{ Origin: '' }, { Origin: 'https://attacker.invalid' }, { 'X-Requested-With': '' }]) {
        assert.equal((await api.request(method, path, body, validCookie, headers)).status, 403);
      }
      assert.equal((await api.request(method, path, body, validCookie, { 'Content-Type': 'text/plain' })).status, 415);
    }
    assert.equal((await api.request('POST', '/api/watchlist', '{')).status, 400);
    assert.equal((await api.request('POST', '/api/watchlist', ' '.repeat(1025))).status, 413);
  } finally { await api.close(); }
  const production = await serve(fakePool(), 'production');
  try { assert.equal((await production.request()).status, 400); }
  finally { await production.close(); }
});

test('watchlist ID validation rejects user IDs, invalid bodies and query parameters before SQL', async () => {
  const api = await serve(fakePool());
  try {
    for (const body of [null, {}, [], { section_id: '11' }, { section_id: 0 }, { section_id: -1 },
      { section_id: 1.5 }, { section_id: 4294967296 }, { section_id: true },
      { section_id: 11, user_id: 2 }, { section_id: 11, unexpected: 1 }, { user_id: 1 }]) {
      assert.equal((await api.request('POST', '/api/watchlist', body)).status, 400, JSON.stringify(body));
    }
    for (const id of ['0', '-1', '1.5', '01', '4294967296', 'abc', '1%20OR%201=1']) {
      assert.equal((await api.request('DELETE', `/api/watchlist/${id}`, {})).status, 400, id);
    }
    assert.equal((await api.request('DELETE', '/api/watchlist/11', { user_id: 2 })).status, 400);
    for (const query of ['?user_id=2', '?section_id=11&section_id=12']) {
      assert.equal((await api.request('GET', `/api/watchlist${query}`)).status, 400);
      assert.equal((await api.request('POST', `/api/watchlist${query}`, { section_id: 11 })).status, 400);
      assert.equal((await api.request('DELETE', `/api/watchlist/11${query}`, {})).status, 400);
    }
  } finally { await api.close(); }
});

test('parameterized watchlist SQL binds the session owner and preserves stored status and nulls', async () => {
  const calls = [];
  const api = await serve(fakePool(async (sql, values) => {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT')) return [[{ section_id: 11, course: 'CS 100', title: 'Intro', subject: 'CS',
      term: '202710', crn: '01234', section: 'H01', max: null, now: null, status: 'CLOSED', is_active: 0, checked_epoch: null }]];
    return [{ affectedRows: 1 }];
  }));
  try {
    const response = await api.request();
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).sections[0], { section_id: 11, course: 'CS 100', title: 'Intro', subject: 'CS',
      term: '202710', crn: '01234', section: 'H01', max: null, now: null, status: 'CLOSED', is_active: false, last_checked_at: null });
    assert.match(calls[0].sql, /WHERE w.user_id = \?/);
    assert.deepEqual(calls[0].values, [1]);
    assert.equal((await api.request('POST', '/api/watchlist', { section_id: 11 })).status, 201);
    assert.match(calls[1].sql, /SELECT \?, id FROM Sections WHERE id = \?/);
    assert.deepEqual(calls[1].values, [1, 11]);
    assert.equal((await api.request('DELETE', '/api/watchlist/11', {})).status, 204);
    assert.match(calls[2].sql, /WHERE user_id = \? AND section_id = \?/);
    assert.deepEqual(calls[2].values, [1, 11]);
  } finally { await api.close(); }
});

test('missing sections, duplicates, foreign-key races and database failures have safe responses', async () => {
  let outcome = 'missing';
  const api = await serve(fakePool(async () => {
    if (outcome === 'missing') return [{ affectedRows: 0 }];
    throw Object.assign(new Error('private SQL/password details'), { code: outcome });
  }));
  try {
    assert.equal((await api.request('POST', '/api/watchlist', { section_id: 11 })).status, 404);
    assert.equal((await api.request('DELETE', '/api/watchlist/11', {})).status, 404);
    for (const [code, status] of [['ER_DUP_ENTRY', 409], ['ER_NO_REFERENCED_ROW_2', 404], ['ECONNREFUSED', 503]]) {
      outcome = code;
      const response = await api.request('POST', '/api/watchlist', { section_id: 11 });
      assert.equal(response.status, status);
      assert.ok(!JSON.stringify(await response.json()).includes('private'));
    }
    outcome = 'ECONNREFUSED';
    assert.equal((await api.request()).status, 503);
    assert.equal((await api.request('DELETE', '/api/watchlist/11', {})).status, 503);
  } finally { await api.close(); }
});

test('MariaDB watchlists persist across app restarts, isolate users and promote/demote real checker targets',
  { skip: !process.env.TEST_DB_PORT && 'Set TEST_DB_PORT to a disposable MariaDB database' }, async () => {
    const database = `watchlist_test_${randomBytes(6).toString('hex')}`;
    const config = { host: '127.0.0.1', port: Number(process.env.TEST_DB_PORT), user: 'root', password: 'test-only-password' };
    const admin = await mysql.createConnection(config);
    const pool = mysql.createPool({ ...config, database, connectionLimit: 5, multipleStatements: true });
    let api;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const schema = await readFile(`${__dirname}/../../database/init/01-schema.sql`, 'utf8');
      await pool.query(schema.replace('USE njit_course_checker;', `USE ${database};`));
      await pool.query("INSERT INTO Courses(id,subject,course_number,title) VALUES (1,'CS','100','Introduction')");
      await pool.query(`INSERT INTO Sections(id,subject,term,crn,section_number,capacity,enrolled,status,course_id) VALUES
        (11,'CS','202710','01234','H01',50,0,'CLOSED',1),
        (12,'CS','202710','01235','002',30,31,'CANCELLED',1),
        (13,'CS','202795','01234','001',30,10,'OPEN',1),
        (14,'IT','202710','99999',NULL,NULL,NULL,NULL,NULL)`);
      const [sectionsBefore] = await pool.query('SELECT * FROM Sections ORDER BY id');
      api = await serve(pool);
      const signup = async name => {
        const credentials = { username: name, email: `${name}@example.invalid`, password: 'test-only-watchlist-password' };
        assert.equal((await api.request('POST', '/api/auth/register', credentials, '')).status, 201);
        const login = await api.request('POST', '/api/auth/login', { identifier: name, password: credentials.password }, '');
        assert.equal(login.status, 200);
        return login.headers.get('set-cookie').split(';')[0];
      };
      const alice = await signup('alice');
      const bob = await signup('bob');
      const list = async cookie => {
        const response = await api.request('GET', '/api/watchlist', undefined, cookie);
        assert.equal(response.status, 200);
        return (await response.json()).sections;
      };
      const add = (cookie, id) => api.request('POST', '/api/watchlist', { section_id: id }, cookie);
      const remove = (cookie, id) => api.request('DELETE', `/api/watchlist/${id}`, {}, cookie);
      assert.deepEqual(await list(alice), []);
      assert.deepEqual(await list(bob), []);
      assert.deepEqual(await api.targets(), { targets: [] });
      assert.equal((await add(alice, 4294967295)).status, 404);
      assert.equal((await add(alice, 11)).status, 201);
      const [initialWatch] = await pool.query('SELECT * FROM Watchlists');
      assert.equal((await add(alice, 11)).status, 409);
      assert.deepEqual((await pool.query('SELECT * FROM Watchlists'))[0], initialWatch);
      const concurrent = await Promise.all([add(alice, 12), add(alice, 12)]);
      assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 409]);
      assert.equal((await add(alice, 13)).status, 201);
      assert.equal((await add(alice, 14)).status, 201);
      assert.equal((await add(bob, 11)).status, 201);
      const watched = await list(alice);
      assert.equal(watched.length, 4);
      assert.equal(watched.filter(row => row.crn === '01234').length, 2, 'same CRN in different terms is distinct');
      assert.equal(watched.find(row => row.section_id === 11).status, 'CLOSED', 'stored status overrides available seats');
      assert.equal(watched.find(row => row.section_id === 14).course, 'IT', 'legacy unlinked watch remains visible');
      assert.deepEqual((await list(bob)).map(row => row.section_id), [11]);
      assert.deepEqual(await api.targets(), { targets: [
        { subject: 'CS', term: '202710' }, { subject: 'CS', term: '202795' }, { subject: 'IT', term: '202710' },
      ] });
      const [storedWatches] = await pool.query('SELECT * FROM Watchlists ORDER BY id');
      await api.close();
      api = await serve(pool);
      assert.deepEqual(await list(alice), watched, 'the same session and watches survive a new app instance');
      assert.deepEqual((await pool.query('SELECT * FROM Watchlists ORDER BY id'))[0], storedWatches);
      assert.equal((await remove(bob, 13)).status, 404, 'cannot delete another user\'s watch');
      assert.equal((await api.request('POST', '/api/watchlist', { section_id: 13, user_id: 1 }, bob)).status, 400);
      assert.equal((await list(alice)).length, 4);
      assert.equal((await remove(alice, 11)).status, 204);
      assert.equal((await remove(alice, 12)).status, 204);
      assert.ok((await api.targets()).targets.some(pair => pair.subject === 'CS' && pair.term === '202710'),
        'another user watching the same pair keeps it promoted');
      assert.equal((await remove(bob, 11)).status, 204);
      assert.ok(!(await api.targets()).targets.some(pair => pair.subject === 'CS' && pair.term === '202710'));
      assert.equal((await remove(alice, 13)).status, 204);
      assert.equal((await remove(alice, 14)).status, 204);
      assert.equal((await remove(alice, 14)).status, 404);
      assert.deepEqual(await list(alice), []);
      assert.deepEqual(await list(bob), []);
      assert.deepEqual(await api.targets(), { targets: [] });
      assert.deepEqual((await pool.query('SELECT * FROM Sections ORDER BY id'))[0], sectionsBefore);
      const search = await api.request('GET', '/api/courses?term=202710&subject=CS', undefined, alice);
      assert.equal(search.status, 200);
      assert.equal((await search.json()).pagination.total, 2);
      assert.deepEqual((await pool.query('SELECT * FROM DepartmentSyncs'))[0], []);
    } finally {
      if (api) await api.close();
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  });
