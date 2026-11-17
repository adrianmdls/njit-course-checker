const express = require('express');
const { createHash, timingSafeEqual } = require('node:crypto');

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function validate(body) {
  const { subject, term, sections } = body || {};
  if (typeof subject !== 'string' || !/^[A-Z][A-Z0-9]{0,9}$/.test(subject) ||
      typeof term !== 'string' || !/^\d{4}(10|50|90|95)$/.test(term)) {
    throw fail(400, 'Invalid subject or term');
  }
  if (!Array.isArray(sections) || !sections.length || sections.length > 10000) {
    throw fail(400, 'Provide 1–10000 normalized sections');
  }
  const courses = new Map();
  const unique = new Map();
  const uint = value => Number.isInteger(value) && value >= 0 && value <= 4294967295;
  for (const row of sections) {
    if (!row || typeof row !== 'object') throw fail(400, 'Invalid section');
    const match = typeof row.course === 'string' && /^([A-Z][A-Z0-9]{0,9})\s+(\d[A-Z0-9]{0,19})$/.exec(row.course);
    let title = typeof row.title === 'string' ? row.title : '';
    if (match && title.startsWith(`${row.course} - `)) title = title.slice(row.course.length + 3);
    if (!match || match[1] !== subject || !title.trim() || [...title].length > 255 ||
        typeof row.crn !== 'string' || !/^\d{5}$/.test(row.crn) ||
        typeof row.section !== 'string' || !row.section.trim() || [...row.section].length > 20 ||
        !['OPEN', 'CLOSED', 'CANCELLED'].includes(row.status) ||
        !uint(row.max_enrollment) || !uint(row.current_enrollment)) {
      throw fail(400, 'Invalid normalized section fields');
    }
    const courseNumber = match[2];
    if (courses.has(courseNumber) && courses.get(courseNumber) !== title) throw fail(400, 'Conflicting course titles');
    courses.set(courseNumber, title);
    const section = { crn: row.crn, courseNumber, title, section_number: row.section,
      capacity: row.max_enrollment, enrolled: row.current_enrollment, status: row.status };
    if (unique.has(row.crn) && JSON.stringify(unique.get(row.crn)) !== JSON.stringify(section)) {
      throw fail(400, 'Conflicting duplicate CRNs');
    }
    unique.set(row.crn, section);
  }
  return { subject, term, courses, sections: [...unique.values()] };
}

async function synchronize(pool, snapshot) {
  const { subject, term, courses, sections } = snapshot;
  // Match src/sync_lock.py so callers using that lock also serialize with this API.
  const lockName = `njit:sync:${subject}:${term}`;
  const connection = await pool.getConnection();
  let locked = false;
  let reusable = true;
  try {
    const [[lock]] = await connection.execute(
      'SELECT GET_LOCK(?, 0) AS acquired', [lockName]);
    if (lock.acquired !== 1) throw fail(lock.acquired === 0 ? 409 : 503, 'Department synchronization unavailable; retry later');
    locked = true;
    await connection.beginTransaction();
    let statusChanges = 0;
    const courseIds = new Map();
    for (const [number, title] of courses) {
      await connection.execute(`INSERT INTO Courses (subject, course_number, title) VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE title = VALUES(title)`, [subject, number, title]);
      const [[course]] = await connection.execute('SELECT id FROM Courses WHERE subject = ? AND course_number = ?', [subject, number]);
      courseIds.set(number, course.id);
    }
    for (const section of sections) {
      const [[existing]] = await connection.execute(
        'SELECT subject, status FROM Sections WHERE term = ? AND crn = ? FOR UPDATE', [term, section.crn]);
      if (existing && existing.subject !== subject) throw fail(409, 'CRN belongs to another subject');
      if (existing && existing.status !== section.status) statusChanges++;
      await connection.execute(`INSERT INTO Sections
        (subject, term, crn, section_number, capacity, enrolled, status, course_id, last_checked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE section_number = VALUES(section_number), capacity = VALUES(capacity),
          enrolled = VALUES(enrolled), status = VALUES(status), course_id = VALUES(course_id),
          last_checked_at = CURRENT_TIMESTAMP`,
      [subject, term, section.crn, section.section_number, section.capacity, section.enrolled,
        section.status, courseIds.get(section.courseNumber)]);
    }
    await connection.execute(`INSERT INTO DepartmentSyncs (subject, term, last_synced_at)
      VALUES (?, ?, CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE last_synced_at = CURRENT_TIMESTAMP`, [subject, term]);
    await connection.commit();
    return { courses: courses.size, sections: sections.length, status_changes: statusChanges };
  } catch (error) {
    // ROLLBACK is harmless if lock acquisition or BEGIN failed before a transaction.
    try { await connection.rollback(); } catch { reusable = false; }
    throw error;
  } finally {
    if (locked && reusable) {
      try {
        const [[release]] = await connection.execute(
          'SELECT RELEASE_LOCK(?) AS released', [lockName]);
        if (release.released !== 1) reusable = false;
      } catch { reusable = false; }
    }
    if (reusable) connection.release();
    else connection.destroy();
  }
}

module.exports = function createDepartmentSync(pool, token = process.env.CHECKER_API_TOKEN) {
  const router = express.Router();
  const digest = value => createHash('sha256').update(value).digest();
  const expected = token ? digest(token) : null;
  router.post('/department', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!expected) return res.status(503).json({ error: 'Department synchronization is not configured' });
    if (process.env.APP_ENV === 'production' && !req.secure) return res.status(400).json({ error: 'HTTPS required' });
    const match = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i.exec(req.get('Authorization') || '');
    if (!timingSafeEqual(digest(match?.[1] || ''), expected) || !match) {
      return res.status(401).json({ error: 'Invalid checker credentials' });
    }
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
    next();
  }, express.json({ limit: '5mb' }), async (req, res, next) => {
    try {
      res.json(await synchronize(pool, validate(req.body)));
    } catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });
  return router;
};
