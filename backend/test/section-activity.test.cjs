const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const createSync = require('../src/department-sync');
const createCourses = require('../src/courses');
const createWatchlist = require('../src/watchlist');

const section = (crn = '01234', status = 'OPEN') => ({ course: 'CS 100', title: 'Intro',
  crn, section: '001', status, max_enrollment: 30, current_enrollment: 20 });
const snapshot = sections => ({ subject: 'CS', term: '202710', sections });
const auth = { sessionMiddleware(req, res, next) { next(); }, requireAuth(req, res, next) { next(); },
  requireMutation(req, res, next) { next(); } };

// Exercise actual route handlers without a listener. Authentication remains covered
// by the existing HTTP suites; these tests target reconciliation and SQL behavior.
async function invoke(router, method, path, request = {}) {
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
  await route.stack.at(-1).handle({ query: {}, user: { id: 1 }, ...request }, res, error => { throw error; });
  return res;
}
const ingest = (pool, sections) => invoke(createSync(pool, 'test-token'), 'post', '/department', { body: snapshot(sections) });

function recordingPool(existing = { subject: 'CS', status: 'CLOSED', is_active: 1 }, fail = '') {
  const calls = [];
  const connection = {
    async execute(sql, params) {
      calls.push({ sql, params });
      if (fail && sql.includes(fail)) throw new Error('injected failure');
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.startsWith('SELECT id FROM Courses')) return [[{ id: 1 }]];
      if (sql.includes('FOR UPDATE')) return [[existing].filter(Boolean)];
      return [[]];
    },
    async beginTransaction() { calls.push({ sql: 'BEGIN' }); },
    async commit() { calls.push({ sql: 'COMMIT' }); },
    async rollback() { calls.push({ sql: 'ROLLBACK' }); },
    release() { calls.push({ sql: 'RELEASE' }); }, destroy() { calls.push({ sql: 'DESTROY' }); },
  };
  return { calls, async getConnection() { return connection; } };
}

test('distinct section titles are accepted for CS/202710 and IT/202690', async () => {
  for (const [subject, term] of [['CS', '202710'], ['IT', '202690']]) {
    const pool = recordingPool(null);
    const response = await invoke(createSync(pool, 'test-token'), 'post', '/department', { body: {
      subject, term, sections: [
        { ...section('09000'), course: `${subject} 100`, title: 'Higher CRN topic' },
        { ...section('00100'), course: `${subject} 100`, title: `${subject} 100 - Lower CRN topic` },
      ],
    } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, { courses: 1, sections: 2, status_changes: 0 });
    assert.deepEqual(pool.calls.find(call => call.sql.includes('INSERT INTO Courses')).params,
      [subject, '100', 'Lower CRN topic']);
    assert.deepEqual(pool.calls.find(call => call.sql.includes('INSERT INTO DepartmentSyncs')).params, [subject, term]);
    assert.equal(pool.calls.at(-3).sql, 'COMMIT');
  }
});

test('each course selects its lowest-CRN normalized title regardless of row order', async () => {
  const rows = [
    { ...section('09000'), title: 'Higher CRN topic' },
    { ...section('00100'), course: 'CS\t100', title: '  CS\u00a0 100   -   Special\tTopics  - AI  ' },
    { ...section('00200'), course: 'CS 101', title: 'CS 101 - Other course' },
    { ...section('08000'), course: 'CS 101', title: 'Different other topic' },
  ];
  for (const order of [rows, [...rows].reverse(), [rows[2], rows[0], rows[3], rows[1]]]) {
    const pool = recordingPool(null);
    assert.equal((await ingest(pool, order)).statusCode, 200);
    const titles = pool.calls.filter(call => call.sql.includes('INSERT INTO Courses'))
      .map(call => call.params.slice(1)).sort(([a], [b]) => a.localeCompare(b));
    assert.deepEqual(titles, [['100', 'Special Topics - AI'], ['101', 'Other course']]);
  }
});

test('duplicate CRNs deduplicate only when normalized titles and section fields agree', async () => {
  const pool = recordingPool(null);
  const response = await ingest(pool, [
    { ...section(), title: '  CS 100 - Intro\u00a0 to\tComputing  ' },
    { ...section(), title: 'Intro to Computing' },
  ]);
  assert.deepEqual(response.body, { courses: 1, sections: 1, status_changes: 0 });
  assert.equal(pool.calls.filter(call => call.sql.includes('INSERT INTO Sections')).length, 1);
  assert.deepEqual(pool.calls.find(call => call.sql.includes('INSERT INTO Courses')).params,
    ['CS', '100', 'Intro to Computing']);
});

test('duplicate CRNs with conflicting normalized titles or persisted fields reject before SQL', async () => {
  for (const fields of [{ title: 'Different title' }, { course: 'CS 101' }, { section: '002' },
    { status: 'CLOSED' }, { max_enrollment: 31 }, { current_enrollment: 21 }]) {
    const pool = recordingPool();
    const response = await ingest(pool, [section(), { ...section(), ...fields }]);
    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.body.validation, { field: 'crn', row_index: 1, reason: 'conflicting_crn' });
    assert.equal(pool.calls.length, 0);
  }
});

test('every section title is validated even if another row would supply the catalog title', async () => {
  for (const crn of ['00100', '09999']) {
    for (const title of ['', ' \t\u00a0 ', ' CS\t100  -  ', 'x'.repeat(256), null]) {
      const pool = recordingPool();
      const response = await ingest(pool, [section(), { ...section(crn), title }]);
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.body.validation, { field: 'title', row_index: 1, reason: 'invalid_title' });
      assert.equal(pool.calls.length, 0);
    }
  }
});

test('nonempty reconciliation scopes/deduplicates CRNs and commits after omission update', async () => {
  const pool = recordingPool();
  const result = await ingest(pool, [section(), section(), section('01235')]);
  assert.equal(result.body.status_changes, 2);
  const omission = pool.calls.find(call => call.sql.startsWith('UPDATE Sections'));
  assert.match(omission.sql, /SET is_active = FALSE/);
  assert.match(omission.sql, /WHERE subject = \? AND term = \?/);
  assert.match(omission.sql, /crn NOT IN \(\?,\?\)/);
  assert.deepEqual(omission.params, ['CS', '202710', '01234', '01235']);
  assert.ok(pool.calls.indexOf(omission) < pool.calls.findIndex(call => call.sql.includes('INSERT INTO DepartmentSyncs')));
  assert.equal(pool.calls.at(-3).sql, 'COMMIT');
  for (const call of pool.calls.filter(call => call.sql.includes('INSERT INTO Sections'))) {
    assert.match(call.sql, /is_active = TRUE/);
    assert.ok(!call.sql.includes('REPLACE'));
  }
});

test('reactivation and new sections do not count as transitions; active changes still do', async () => {
  for (const [existing, count] of [[{ subject: 'CS', status: 'CLOSED', is_active: 0 }, 0],
    [null, 0], [{ subject: 'CS', status: 'CLOSED', is_active: 1 }, 1]]) {
    const result = await ingest(recordingPool(existing), [section()]);
    assert.equal(result.body.status_changes, count);
  }
});

test('empty snapshots do not write any section fields or activity', async () => {
  const pool = recordingPool();
  assert.deepEqual((await ingest(pool, [])).body, { courses: 0, sections: 0, status_changes: 0 });
  assert.ok(!pool.calls.some(call => /\bSections\b/.test(call.sql)));
  assert.ok(pool.calls.some(call => call.sql.includes('INSERT INTO DepartmentSyncs')));
});

test('failure after omission update rolls back before releasing the department lock', async () => {
  const pool = recordingPool(undefined, 'INSERT INTO DepartmentSyncs');
  await assert.rejects(ingest(pool, [{ ...section('09000'), title: 'Other topic' }, section()]), /injected/);
  assert.deepEqual(pool.calls.find(call => call.sql.includes('INSERT INTO Courses')).params, ['CS', '100', 'Intro']);
  assert.ok(pool.calls.some(call => call.sql.startsWith('UPDATE Sections')));
  assert.ok(!pool.calls.some(call => call.sql === 'COMMIT'));
  assert.equal(pool.calls.at(-3).sql, 'ROLLBACK');
  assert.match(pool.calls.at(-2).sql, /RELEASE_LOCK/);
  assert.equal(pool.calls.at(-1).sql, 'RELEASE');
});

test('an invalid later row rejects the whole snapshot before acquiring a connection', async () => {
  let accessed = false;
  const pool = { getConnection() { accessed = true; throw new Error('Unexpected SQL'); } };
  const response = await ingest(pool, [section(), { ...section('01235'), status: 'INVALID' }]);
  assert.equal(response.statusCode, 400);
  assert.equal(accessed, false);
});

test('search filters activity in count/page/options; watchlist and targets keep inactive rows', async () => {
  const calls = [];
  const pool = { async execute(sql, params) {
    calls.push({ sql, params });
    if (sql.includes('COUNT(*)')) return [[{ total: 1 }]];
    if (sql.includes('SELECT DISTINCT')) return [[{ subject: 'CS', term: '202710' }]];
    return [[{ id: 1, section_id: 1, status: 'OPEN', is_active: sql.includes('FROM Watchlists') ? 0 : 1,
      checked_epoch: 1794916800 }]];
  } };
  const courses = createCourses(pool, auth);
  const page = await invoke(courses, 'get', '/', { query: { term: '202710' } });
  assert.equal(page.body.sections[0].is_active, true);
  assert.ok(calls.slice(0, 2).every(call => /s.is_active = TRUE/.test(call.sql)));
  await invoke(courses, 'get', '/options');
  assert.match(calls.at(-1).sql, /WHERE s.is_active = TRUE/);
  const watched = await invoke(createWatchlist(pool, auth), 'get', '/');
  assert.equal(watched.body.sections[0].is_active, false);
  assert.equal(watched.body.sections[0].status, 'OPEN');
  assert.equal(watched.body.sections[0].last_checked_at, new Date(1794916800000).toISOString());
  assert.ok(!/WHERE.*is_active/s.test(calls.at(-1).sql));
  await invoke(createSync(pool, 'test-token'), 'get', '/targets', { query: { watched_only: 'true' } });
  assert.ok(!calls.at(-1).sql.includes('is_active'));
});

test('MariaDB migration, omission, reactivation, rollback and historical watch/search behavior',
  { skip: !process.env.TEST_DB_PORT && 'Set TEST_DB_PORT to a disposable MariaDB server only' }, async () => {
    const database = `activity_test_${randomBytes(6).toString('hex')}`;
    const config = { host: process.env.TEST_DB_HOST || '127.0.0.1', port: Number(process.env.TEST_DB_PORT),
      user: 'root', password: process.env.TEST_DB_PASSWORD || 'test-only-password' };
    const admin = await mysql.createConnection(config);
    const pool = mysql.createPool({ ...config, database, connectionLimit: 5, multipleStatements: true });
    let owned = false;
    try {
      await admin.query(`CREATE DATABASE ${database}`); owned = true;
      const schema = await readFile(`${__dirname}/../../database/init/01-schema.sql`, 'utf8');
      // Reproduce an existing volume without the new column, including optional
      // experimental columns. Only this random schema is ever migrated.
      await pool.query(schema.replace('USE njit_course_checker;', `USE ${database};`)
        .replace('    is_active BOOLEAN NOT NULL DEFAULT TRUE,\n', ''));
      await pool.query(`ALTER TABLE Sections ADD snapshot_generation BIGINT UNSIGNED NOT NULL DEFAULT 7;
        ALTER TABLE DepartmentSyncs ADD snapshot_generation BIGINT UNSIGNED NOT NULL DEFAULT 7,
          ADD last_refresh_status ENUM('success','error') DEFAULT 'error',
          ADD last_refresh_source ENUM('scheduled','on_demand') DEFAULT 'on_demand'`);
      await pool.query("INSERT INTO Courses(id,subject,course_number,title) VALUES(1,'CS','100','Intro'),(2,'IT','100','Intro')");
      await pool.query(`INSERT INTO Sections(id,subject,term,crn,status,course_id,last_checked_at) VALUES
        (1,'CS','202710','01234','OPEN',1,'2000-01-01'),
        (2,'CS','202710','01235','CLOSED',1,'2000-01-01'),
        (3,'CS','202710','01236','CANCELLED',1,'2000-01-01'),
        (4,'CS','202795','01234','OPEN',1,'2000-01-01'),
        (5,'IT','202710','02234','OPEN',2,'2000-01-01')`);
      await pool.query("INSERT INTO Users(id,username,email,password_hash) VALUES(1,'watcher','test@example.invalid','unused')");
      await pool.query('INSERT INTO Watchlists(user_id,section_id) VALUES(1,1),(1,2),(1,3)');
      const rows = async () => (await pool.query('SELECT * FROM Sections ORDER BY id'))[0];
      const before = await rows();
      await pool.query(await readFile(`${__dirname}/../../database/migrations/04-section-activity.sql`, 'utf8'));
      const migrated = await rows();
      assert.deepEqual(migrated.map(({ is_active, ...row }) => row), before);
      assert.ok(migrated.every(row => row.is_active === 1));
      const watches = (await pool.query('SELECT * FROM Watchlists ORDER BY id'))[0];
      const count = async sections => {
        const response = await ingest(pool, sections);
        assert.equal(response.statusCode, 200);
        return response.body.status_changes;
      };
      assert.equal(await count([section()]), 0);
      const omitted = await rows();
      assert.deepEqual(omitted.map(row => row.is_active), [1, 0, 0, 1, 1]);
      for (const index of [1, 2]) assert.deepEqual(omitted[index], { ...migrated[index], is_active: 0 });
      assert.deepEqual((await pool.query('SELECT * FROM Watchlists ORDER BY id'))[0], watches);
      const courses = createCourses(pool, auth);
      const search = await invoke(courses, 'get', '/', { query: { term: '202710', subject: 'CS', limit: '1' } });
      assert.equal(search.body.pagination.total, 1);
      assert.deepEqual(search.body.sections.map(row => row.id), [1]);
      assert.equal(search.body.sections[0].is_active, true);
      assert.equal((await invoke(courses, 'get', '/', { query: { term: '202710', subject: 'CS', offset: '1' } })).body.sections.length, 0);
      const watched = (await invoke(createWatchlist(pool, auth), 'get', '/')).body.sections;
      assert.deepEqual(watched.map(row => row.section_id).sort(), [1, 2, 3]);
      assert.equal(watched.find(row => row.section_id === 2).is_active, false);
      assert.equal(watched.find(row => row.section_id === 2).status, 'CLOSED');
      assert.ok((await invoke(createSync(pool, 'test-token'), 'get', '/targets')).body.targets.some(pair => pair.subject === 'CS'));
      assert.equal(await count([]), 0);
      assert.deepEqual(await rows(), omitted, 'empty preserves both active and inactive rows exactly');
      const capture = async () => ({ sections: await rows(), watches: (await pool.query('SELECT * FROM Watchlists ORDER BY id'))[0],
        syncs: (await pool.query('SELECT * FROM DepartmentSyncs ORDER BY subject,term'))[0],
        courses: (await pool.query('SELECT * FROM Courses ORDER BY id'))[0] });
      const beforeFailure = await capture();
      await pool.query("CREATE TRIGGER fail_activity BEFORE INSERT ON DepartmentSyncs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected failure'");
      await assert.rejects(count([{ ...section('01235'), title: 'Returning topic' },
        { ...section('01237'), title: 'New section topic' }]));
      assert.deepEqual(await capture(), beforeFailure);
      await pool.query('DROP TRIGGER fail_activity');
      assert.equal(await count([section('01235')]), 0, 'CLOSED to OPEN on reappearance is not a transition');
      assert.equal((await rows())[1].id, 2);
      assert.equal((await rows())[1].is_active, 1);
      assert.deepEqual((await pool.query('SELECT * FROM Watchlists ORDER BY id'))[0], watches);
      assert.equal(await count([section('01235')]), 0, 'idempotent repetition');
      assert.equal(await count([section('01235', 'CLOSED')]), 1);
      assert.equal(await count([section('01235')]), 1, 'continuously active CLOSED to OPEN counts');
      const differentTitles = [{ ...section('01235'), title: ' CS 100 - Primary\t topic ' },
        { ...section('01237'), title: 'Other topic' }];
      for (const order of [differentTitles, [...differentTitles].reverse()]) {
        assert.equal(await count(order), 0);
        const [[course]] = await pool.query("SELECT title FROM Courses WHERE subject='CS' AND course_number='100'");
        assert.equal(course.title, 'Primary topic');
        assert.equal((await rows()).find(row => row.crn === '01235').id, 2);
        assert.deepEqual((await pool.query('SELECT * FROM Watchlists ORDER BY id'))[0], watches);
      }
      assert.ok((await rows()).every(row => row.snapshot_generation === 7));
      const [[metadata]] = await pool.query('SELECT snapshot_generation,last_refresh_status,last_refresh_source FROM DepartmentSyncs');
      assert.deepEqual(metadata, { snapshot_generation: 7, last_refresh_status: 'error', last_refresh_source: 'on_demand' });
      // Catalog options must also remove a department/term with only inactive rows.
      await pool.query("UPDATE Sections SET is_active=FALSE WHERE subject='IT' OR term='202795'");
      assert.deepEqual((await invoke(courses, 'get', '/options')).body, { terms: [{ code: '202710', departments: ['CS'] }] });
    } finally {
      await pool.end();
      if (owned) await admin.query(`DROP DATABASE ${database}`);
      await admin.end();
    }
  });
