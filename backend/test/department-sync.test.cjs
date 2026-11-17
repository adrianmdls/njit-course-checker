const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const mysql = require('mysql2/promise');
const { readFile } = require('node:fs/promises');
const createSync = require('../src/department-sync');

const token = 'test-checker-token';
const section = (extra = {}) => ({ course: 'CS 100', title: 'CS 100 - Roadmap to Computing',
  crn: '12345', section: '001', status: 'OPEN', max_enrollment: 30, current_enrollment: 20, ...extra });
const snapshot = (extra = {}) => ({ subject: 'CS', term: '202710', sections: [section()], ...extra });

async function serve(pool, secret = token) {
  const app = express();
  app.use('/api/internal/sync', createSync(pool, secret));
  app.use((error, req, res, next) => res.status(error.type === 'entity.parse.failed' ? 400 :
    error.type === 'entity.too.large' ? 413 : 503).json({ error: 'Request failed' }));
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, '127.0.0.1', error => error ? reject(error) : resolve(listening));
  });
  return {
    post: (body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}/api/internal/sync/department`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

test('authentication and validation reject requests before accessing the database', async () => {
  const api = await serve({ getConnection() { throw new Error('Database must not be accessed'); } });
  try {
    for (const authorization of ['', 'Basic abc', 'Bearer wrong', 'Bearer short', `Bearer ${token} extra`]) {
      assert.equal((await api.post('{', { Authorization: authorization })).status, 401);
    }
    assert.equal((await api.post(snapshot(), { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await api.post('{')).status, 400);
    assert.equal((await api.post(' '.repeat(5 * 1024 * 1024 + 1))).status, 413);
    const invalid = [null, { subject: 'cs' }, { subject: 'CS; DROP TABLE Courses' },
      { term: '202711' }, { term: 202710 }, { sections: [] },
      ...[{ course: 'IT 100' }, { course: 'CS' }, { crn: '1234' }, { crn: 12345 },
        { title: '' }, { section: '' }, { status: 'open' }, { status: 'FULL' },
        { max_enrollment: -1 }, { current_enrollment: 1.5 }, { current_enrollment: '20' },
        { max_enrollment: 4294967296 }].map(fields => ({ sections: [section(fields)] })),
      { sections: [section(), section({ status: 'CLOSED' })] },
      { sections: [section(), section({ crn: '12346', title: 'Different' })] }];
    for (const fields of invalid) {
      const body = fields === null ? null : snapshot(fields);
      assert.equal((await api.post(body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await api.post({})).status, 400);
  } finally { await api.close(); }
  const disabled = await serve({}, '');
  try { assert.equal((await disabled.post(snapshot())).status, 503); }
  finally { await disabled.close(); }
});

test('production requires HTTPS for machine authentication', async () => {
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = 'production';
  const api = await serve({});
  try { assert.equal((await api.post(snapshot())).status, 400); }
  finally {
    if (previous === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previous;
    await api.close();
  }
});

test('MariaDB upserts, watchlists, rollback, idempotency, Winter terms and locking',
  { skip: !process.env.TEST_DB_PORT && 'Set TEST_DB_PORT to a disposable MariaDB database' }, async () => {
    const pool = mysql.createPool({ host: '127.0.0.1', port: Number(process.env.TEST_DB_PORT),
      user: 'root', password: 'test-only-password', database: 'njit_course_checker',
      connectionLimit: 5, multipleStatements: true });
    let api;
    try {
      // This suite owns a disposable database. Never point it at a project database.
      await pool.query(await readFile(`${__dirname}/../../database/init/01-schema.sql`, 'utf8'));
      api = await serve(pool);
      const body = snapshot({ sections: [section(), section({ crn: '12346', section: '002' }), section()] });
      let response = await api.post(body);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { courses: 1, sections: 2, status_changes: 0 });
      const [original] = await pool.query('SELECT id, crn FROM Sections ORDER BY crn');
      await pool.execute("INSERT INTO Users (username,email,password_hash) VALUES ('watcher','watcher@example.invalid','unused')");
      await pool.execute('INSERT INTO Watchlists (user_id,section_id) VALUES (1,?)', [original[0].id]);
      await pool.query("UPDATE DepartmentSyncs SET last_synced_at = '2000-01-01 00:00:00'");
      response = await api.post(body);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status_changes, 0);
      const [[sync]] = await pool.query('SELECT UNIX_TIMESTAMP(last_synced_at) AS synced FROM DepartmentSyncs');
      assert.ok(sync.synced > Date.UTC(2000, 0, 2) / 1000, 'successful retries refresh synchronization time');
      const [[recordCounts]] = await pool.query('SELECT (SELECT COUNT(*) FROM Courses) AS courses, (SELECT COUNT(*) FROM Sections) AS sections');
      assert.deepEqual(recordCounts, { courses: 1, sections: 2 });

      const changed = snapshot({ sections: body.sections.slice(0, 2).map(row => ({ ...row, status: 'CLOSED', current_enrollment: 31 })) });
      response = await api.post(changed);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status_changes, 2);
      const [updated] = await pool.query('SELECT id,crn,status,enrolled FROM Sections ORDER BY crn');
      assert.deepEqual(updated.map(({ id, crn }) => ({ id, crn })), original);
      assert.ok(updated.every(row => row.status === 'CLOSED' && row.enrolled === 31));
      const [[watch]] = await pool.query('SELECT section_id FROM Watchlists');
      assert.equal(watch.section_id, original[0].id);
      // Ordering is the caller's responsibility: an older snapshot can be applied again.
      response = await api.post(body);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status_changes, 2);
      response = await api.post(changed);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status_changes, 2);
      response = await api.post(changed);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status_changes, 0);

      const lock = await pool.getConnection();
      try {
        await lock.execute('SELECT GET_LOCK(?,0)', ['njit:sync:CS:202710']);
        assert.equal((await api.post(changed)).status, 409);
      } finally {
        await lock.execute('SELECT RELEASE_LOCK(?)', ['njit:sync:CS:202710']);
        lock.release();
      }

      await pool.query("CREATE TRIGGER fail_sync BEFORE INSERT ON DepartmentSyncs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='injected failure'");
      const [beforeFailure] = await pool.query('SELECT * FROM DepartmentSyncs');
      const failedUpdate = snapshot({ sections: changed.sections.map(row => ({ ...row,
        title: 'CS 100 - Changed title', status: 'CANCELLED' })) });
      assert.equal((await api.post(failedUpdate)).status, 503);
      const [afterFailure] = await pool.query('SELECT * FROM DepartmentSyncs');
      assert.deepEqual(afterFailure, beforeFailure, 'failed synchronization preserves completion timestamp');
      const [afterRollback] = await pool.query('SELECT id,crn,status,enrolled FROM Sections ORDER BY crn');
      assert.deepEqual(afterRollback, updated, 'existing section updates roll back');
      const [[courseAfterRollback]] = await pool.query('SELECT title FROM Courses');
      assert.equal(courseAfterRollback.title, 'Roadmap to Computing');
      const rollbackBody = snapshot({ term: '202790', sections: [section({ course: 'CS 101', title: 'CS 101 - New course' })] });
      assert.equal((await api.post(rollbackBody)).status, 503);
      const [[counts]] = await pool.query("SELECT (SELECT COUNT(*) FROM Courses WHERE course_number='101') AS courses, (SELECT COUNT(*) FROM Sections WHERE term='202790') AS sections, (SELECT COUNT(*) FROM DepartmentSyncs WHERE term='202790') AS syncs");
      assert.deepEqual(counts, { courses: 0, sections: 0, syncs: 0 });
      await pool.query('DROP TRIGGER fail_sync');
      assert.equal((await api.post(rollbackBody)).status, 200, 'rollback released connection lock');

      const collision = snapshot({ subject: 'IT', sections: [section({ course: 'IT 100' })] });
      assert.equal((await api.post(collision)).status, 409);
      const [[count]] = await pool.query('SELECT COUNT(*) AS count FROM Watchlists');
      assert.equal(count.count, 1);
      const [[collisionCount]] = await pool.query("SELECT COUNT(*) AS count FROM Courses WHERE subject='IT'");
      assert.equal(collisionCount.count, 0, 'subject collision rolls back course upsert');
      response = await api.post(snapshot({ term: '202795' }));
      assert.equal(response.status, 200, 'Winter matches the existing checker term codes');
      assert.deepEqual(await response.json(), { courses: 1, sections: 1, status_changes: 0 });

      for (const [number, title, expected] of [
        ['101', 'IT 101 - Introduction to IT', 'Introduction to IT'],
        ['490', 'Special Topics - AI', 'Special Topics - AI'],
        ['490', 'IT 490 - Systems Integration - Capstone', 'Systems Integration - Capstone'],
      ]) {
        response = await api.post(snapshot({ subject: 'IT', sections: [section({
          course: `IT ${number}`, title, crn: '54321',
        })] }));
        assert.equal(response.status, 200, title);
        const [[course]] = await pool.execute(
          'SELECT title FROM Courses WHERE subject = ? AND course_number = ?', ['IT', number]);
        assert.equal(course.title, expected, title);
      }
    } finally {
      if (api) await api.close();
      await pool.end();
    }
  });
