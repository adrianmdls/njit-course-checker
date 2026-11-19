const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHmac, randomBytes } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const express = require('express');
const mysql = require('mysql2/promise');
const createAuth = require('../src/auth');
const createCourses = require('../src/courses');

const secret = 'course-search-test-secret-at-least-32-bytes';
const user = { id: 1, username: 'searcher', email: 'searcher@example.invalid', email_verified: 0 };
const signedCookie = id => `njit.sid=${encodeURIComponent(`s:${id}.${createHmac('sha256', secret).update(id).digest('base64').replace(/=+$/, '')}`)}`;
const validCookie = signedCookie('valid-session');

// Only the session/user database responses are faked here. Real auth middleware
// verifies signatures, restores sessions, checks age, and looks up the user.
function fakePool(execute = async sql => sql.includes('COUNT(*)') ? [[{ total: 0 }]] : [[]]) {
  return {
    async query(sql, params) {
      if (sql.startsWith('SELECT ??')) {
        const id = params[4];
        if (!['valid-session', 'expired-session', 'deleted-user'].includes(id)) return [[]];
        return [[{ expires: Math.floor(Date.now() / 1000) + 1800,
          data: JSON.stringify({ cookie: { maxAge: 1800000, httpOnly: true, path: '/' },
            userId: id === 'deleted-user' ? 2 : 1,
            authenticatedAt: Date.now() - (id === 'expired-session' ? 9 * 3600000 : 0) }) }]];
      }
      return [[]];
    },
    execute: (sql, params) => sql.includes('FROM Users') ? Promise.resolve([params[0] === 1 ? [user] : []]) : execute(sql, params),
  };
}

async function serve(pool) {
  process.env.APP_ENV = 'development';
  process.env.APP_ORIGIN = 'http://localhost:8080';
  process.env.SESSION_SECRET = secret;
  const auth = await createAuth(pool);
  const app = express();
  app.use('/api/auth', auth.router);
  app.use('/api/courses', createCourses(pool, auth));
  app.use((error, req, res, next) => {
    // Same database error classification and public response as server.js.
    const databaseError = /^(ER_|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|PROTOCOL_)/.test(error.code || '') || error.message === 'Queue limit reached.';
    res.status(databaseError ? 503 : 500).json({ error: databaseError ? 'Service temporarily unavailable' : 'Internal server error' });
  });
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(listening));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    options: (cookie = validCookie, query = '') => fetch(`${base}/api/courses/options${query}`, { headers: { Cookie: cookie } }),
    get: (query = 'term=202710&subject=CS', cookie = validCookie, headers = {}) => fetch(`${base}/api/courses?${query}`, {
      headers: { Cookie: cookie, ...headers },
    }),
    post: (path, body, cookie = '') => fetch(`${base}/api/auth/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: process.env.APP_ORIGIN,
        'X-Requested-With': 'NJIT-Course-Checker', Cookie: cookie }, body: JSON.stringify(body),
    }),
    async close() {
      await new Promise(resolve => server.close(resolve));
      await auth.close();
    },
  };
}

test('course search requires a valid session and existing user, not a checker token', async () => {
  const api = await serve(fakePool(() => { throw new Error('Search must not run'); }));
  try {
    for (const cookie of ['', 'njit.sid=invalid', signedCookie('missing'), signedCookie('expired-session'), signedCookie('deleted-user')]) {
      const response = await api.get('term=202710&subject=CS', cookie, { Authorization: 'Bearer test-checker-token' });
      assert.equal(response.status, 401, cookie);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await api.options(cookie)).status, 401);
    }
  } finally { await api.close(); }
});

test('course search validates all parameters and duplicates before querying courses', async () => {
  const api = await serve(fakePool(() => { throw new Error('Search must not run'); }));
  try {
    const invalid = ['term=202710', 'term=202710&query=CS%20280',
      ...['', 'term=', 'term=202711', 'term=20271', 'term=2027100', 'term=2027a0',
        'term=202710&term=202795', 'term[]=202710', 'term[x]=202710'].map(query => `${query}&subject=CS`),
      ...['subject=', 'subject=cs', 'subject=1CS', 'subject=ABCDEFGHIJK', 'subject=CS%27',
        'query=', 'query=CS', 'query=CS280', 'query=280%25', 'query=280_',
        'query=280%27%20OR%201=1', 'query=CS%20280&subject=IT',
        `query=${'2'.repeat(101)}`, `query=${'2'.repeat(21)}`, 'query=CS%20280%20extra',
        'status=open', 'status=FULL', 'status=', 'sort=title', 'sort=crn%3BDROP%20TABLE%20Courses',
        'order=ASC', 'order=desc%3BSELECT%201', 'limit=0', 'limit=-1', 'limit=101', 'limit=1.5',
        'limit=1e2', 'limit=', 'offset=-1', 'offset=1.5', 'offset=2147483648',
        'offset=99999999999999999999999', 'offset=', 'unknown=1',
        ...['subject', 'query', 'status', 'sort', 'order', 'limit', 'offset'].map(key => `${key}=1&${key}=2`),
      ].map(query => `term=202710&${query.includes('subject=') ? '' : 'subject=CS&'}${query}`)];
    for (const query of invalid) assert.equal((await api.get(query)).status, 400, query);
  } finally { await api.close(); }
});

test('valid filters are parameterized, terms include Winter, and empty results include pagination', async () => {
  const calls = [];
  const api = await serve(fakePool(async (sql, params) => {
    calls.push({ sql, params });
    return sql.includes('COUNT(*)') ? [[{ total: 0 }]] : [[]];
  }));
  try {
    for (const suffix of ['10', '50', '90', '95']) {
      const response = await api.get(`term=2027${suffix}&subject=CS`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { sections: [], pagination: { limit: 50, offset: 0, total: 0 } });
    }
    const response = await api.get('term=202795&query=%20cs%20%20%20280a%20&subject=CS&status=CLOSED&sort=availability&order=desc&limit=100&offset=2147483647');
    assert.equal(response.status, 200);
    assert.deepEqual(calls.at(-2).params, ['202795', 'CS', '280A%', 'CLOSED']);
    assert.deepEqual(calls.at(-1).params, ['202795', 'CS', '280A%', 'CLOSED', 100, 2147483647]);
    assert.match(calls.at(-1).sql, /INNER JOIN Courses c ON s.course_id = c.id/);
    assert.match(calls.at(-1).sql, /s.id DESC/);
    assert.match(calls.at(-2).sql, /s.is_active = TRUE/);
    assert.match(calls.at(-1).sql, /s.is_active = TRUE/);
    assert.ok(!calls.at(-1).sql.includes('280A'));
  } finally { await api.close(); }
});

test('database failures are sanitized, including connection, SQL, and queue failures', async () => {
  let failure;
  const api = await serve(fakePool(async () => { throw failure; }));
  try {
    for (const code of ['ECONNREFUSED', 'ER_SERVER_SHUTDOWN', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT', undefined]) {
      failure = Object.assign(new Error(code ? 'sensitive SQL and credentials' : 'Queue limit reached.'), { code });
      const response = await api.get();
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'Service temporarily unavailable' });
      assert.equal((await api.options()).status, 503);
    }
  } finally { await api.close(); }
});

test('catalog options use local DISTINCT joined pairs, reject parameters, and support empty catalogs', async () => {
  const calls = [];
  let rows = [{ term: '202795', subject: 'ECE' }, { term: '202710', subject: 'CS' }, { term: '202710', subject: 'IT' }];
  const api = await serve(fakePool(async (sql, params) => { calls.push({ sql, params }); return [rows]; }));
  try {
    const response = await api.options();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { terms: [
      { code: '202795', departments: ['ECE'] }, { code: '202710', departments: ['CS', 'IT'] },
    ] });
    assert.match(calls[0].sql, /SELECT DISTINCT s.term, c.subject/);
    assert.match(calls[0].sql, /WHERE s.is_active = TRUE/);
    assert.match(calls[0].sql, /INNER JOIN Courses c ON s.course_id = c.id/);
    assert.match(calls[0].sql, /ORDER BY s.term DESC, c.subject ASC/);
    for (const query of ['?term=202710', '?subject=CS&subject=IT', '?query=1%27%20OR%201=1']) {
      assert.equal((await api.options(validCookie, query)).status, 400);
    }
    assert.equal(calls.length, 1, 'invalid options queries do not access the catalog');
    rows = [];
    assert.deepEqual(await (await api.options()).json(), { terms: [] });
  } finally { await api.close(); }
});

test('MariaDB course search with real login, filters, all sort directions, pagination and nullable fields',
  { skip: !process.env.TEST_DB_PORT && 'Set TEST_DB_PORT to a disposable MariaDB database' }, async () => {
    // This suite uses its own schema on the disposable server so it can run
    // alongside department-sync tests without sharing users or fixture records.
    const database = `course_search_test_${randomBytes(6).toString('hex')}`;
    const pool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.TEST_DB_PORT),
      user: 'root', password: 'test-only-password', connectionLimit: 5, multipleStatements: true, database });
    const admin = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.TEST_DB_PORT),
      user: 'root', password: 'test-only-password' });
    let api;
    try {
      await admin.query(`CREATE DATABASE ${database}`);
      const schema = await readFile(`${__dirname}/../../database/init/01-schema.sql`, 'utf8');
      await pool.query(schema.replace('USE njit_course_checker;', `USE ${database};`));
      await pool.query("INSERT INTO Courses (id,subject,course_number,title) VALUES (1,'CS','280','Concepts'),(2,'CS','280A','Honors'),(3,'IT','280','IT Topics'),(4,'CS','100','Intro')");
      const fixtures = [
        [1, 1, 'CS', '202710', '08002', '002', 35, 28, 'OPEN', '2026-11-17 15:30:00'],
        [2, 1, 'CS', '202710', '08001', '001', 35, 35, 'CLOSED', null],
        [3, 2, 'CS', '202710', '08003', '001', 30, 32, 'CANCELLED', null],
        [4, 3, 'IT', '202710', '08004', '001', 10, 3, 'OPEN', null],
        [5, 4, 'CS', '202710', '08005', null, null, 5, null, null],
        [6, 4, 'CS', '202710', '08006', '002', 20, null, 'CLOSED', null],
        [7, 4, 'CS', '202710', '08007', '002', 20, 13, 'OPEN', null],
        [8, 4, 'CS', '202710', '08008', '002', null, null, 'OPEN', null],
        [9, 1, 'CS', '202795', '08009', '001', 35, 1, 'CLOSED', null],
      ];
      for (const row of fixtures) await pool.execute(`INSERT INTO Sections
        (id,course_id,subject,term,crn,section_number,capacity,enrolled,status,last_checked_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, row);
      // Legacy unlinked sections must be excluded by the INNER JOIN.
      await pool.execute("INSERT INTO Sections (subject,term,crn) VALUES ('CS','202710','09999')");
      api = await serve(pool);
      assert.equal((await api.get('term=202710&subject=CS', '')).status, 401);
      const credentials = { username: 'searcher', email: 'searcher@example.invalid', password: 'test password with enough characters' };
      assert.equal((await api.post('register', credentials)).status, 201);
      const login = await api.post('login', { identifier: credentials.username, password: credentials.password });
      assert.equal(login.status, 200);
      const cookie = login.headers.get('set-cookie').split(';')[0];
      const [beforeOptions] = await pool.query('SELECT * FROM Sections ORDER BY id');
      assert.deepEqual(await (await api.options(cookie)).json(), { terms: [
        { code: '202795', departments: ['CS'] }, { code: '202710', departments: ['CS', 'IT'] },
      ] });
      assert.deepEqual((await pool.query('SELECT * FROM Sections ORDER BY id'))[0], beforeOptions);
      const search = async (query = '') => {
        const params = new URLSearchParams({ term: '202710', subject: 'CS' });
        for (const [key, value] of new URLSearchParams(query.replace(/^&/, ''))) params.set(key, value);
        const response = await api.get(params.toString(), cookie);
        assert.equal(response.status, 200, query);
        return response.json();
      };
      assert.deepEqual((await search()).sections.map(row => row.id), [5, 6, 7, 8, 2, 1, 3]);
      assert.equal((await search()).pagination.total, 7);
      assert.deepEqual((await search('&subject=IT')).sections.map(row => row.id), [4]);
      assert.equal((await search('&query=280')).pagination.total, 3);
      assert.deepEqual((await search('&query=%20cs%20%20%20280%20')).sections.map(row => row.id), [2, 1, 3]);
      assert.equal((await api.get('term=202710&subject=IT&query=CS%20280', cookie)).status, 400);
      for (const [status, count] of [['OPEN', 3], ['CLOSED', 2], ['CANCELLED', 1]]) {
        const result = await search(`&status=${status}`);
        assert.equal(result.pagination.total, count);
        assert.ok(result.sections.every(row => row.status === status));
      }
      const sorts = {
        course: [5, 6, 7, 8, 2, 1, 3], crn: [2, 1, 3, 5, 6, 7, 8],
        availability: [3, 2, 7, 1, 5, 6, 8],
      };
      for (const [sort, ascending] of Object.entries(sorts)) {
        for (const order of ['asc', 'desc']) {
          const expected = order === 'asc' ? ascending : sort === 'availability'
            ? [1, 7, 2, 3, 8, 6, 5] : [...ascending].reverse();
          const result = await search(`&sort=${sort}&order=${order}`);
          assert.deepEqual(result.sections.map(row => row.id), expected, `${sort} ${order}`);
          const paged = [];
          for (let offset = 0; offset < 7; offset += 3) {
            const page = await search(`&sort=${sort}&order=${order}&limit=3&offset=${offset}`);
            assert.deepEqual(page.pagination, { limit: 3, offset, total: 7 });
            paged.push(...page.sections.map(row => row.id));
          }
          assert.deepEqual(paged, expected);
        }
      }
      const result = await search('&query=CS%20280&sort=crn&order=desc');
      assert.deepEqual(result.sections.find(row => row.id === 1), {
        id: 1, course: 'CS 280', subject: 'CS', course_number: '280', title: 'Concepts', term: '202710',
        crn: '08002', section: '002', max: 35, now: 28, status: 'OPEN', is_active: true, last_checked_at: '2026-11-17T15:30:00.000Z',
      });
      const nullable = (await search()).sections.find(row => row.id === 5);
      for (const field of ['max', 'section', 'status', 'last_checked_at']) assert.equal(nullable[field], null);
      assert.equal((await search()).sections.find(row => row.id === 6).now, null);
      assert.equal((await search()).sections.find(row => row.id === 8).max, null);
      assert.equal((await search()).sections.find(row => row.id === 8).now, null);
      assert.deepEqual(await search('&subject=ECE'), { sections: [], pagination: { limit: 50, offset: 0, total: 0 } });
      assert.deepEqual(await search('&offset=100'), { sections: [], pagination: { limit: 50, offset: 100, total: 7 } });
      for (const term of ['202750', '202790', '202795']) {
        const response = await api.get(`term=${term}&subject=CS`, cookie);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.pagination.total, term === '202795' ? 1 : 0);
        if (term === '202795') assert.equal(body.sections[0].status, 'CLOSED', 'stored status overrides available seat counts');
      }
      // An actual SQL failure must reach the same sanitized database response.
      await pool.query('RENAME TABLE Sections TO UnavailableSections');
      const unavailable = await api.get('term=202710&subject=CS', cookie);
      assert.equal(unavailable.status, 503);
      assert.deepEqual(await unavailable.json(), { error: 'Service temporarily unavailable' });
      assert.equal((await api.options(cookie)).status, 503);
      assert.equal((await api.post('logout', {}, cookie)).status, 204);
      assert.equal((await api.get('term=202710&subject=CS', cookie)).status, 401);
    } finally {
      if (api) await api.close();
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${database}`);
      await admin.end();
    }
  });
