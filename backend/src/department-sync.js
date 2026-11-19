const express = require('express');
const { createHash, timingSafeEqual } = require('node:crypto');

function fail(status, message) {
  return Object.assign(new Error(message), { status });
}

function invalid(field, reason, row_index = null) {
  return Object.assign(fail(400, 'Invalid department snapshot'), {
    validation: { field, row_index, reason },
  });
}

function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('body', 'invalid_body');
  const { subject, term, sections } = body;
  if (typeof subject !== 'string' || !/^[A-Z][A-Z0-9]{0,9}$/.test(subject)) throw invalid('subject', 'invalid_subject');
  if (typeof term !== 'string' || !/^\d{4}(10|50|90|95)$/.test(term)) throw invalid('term', 'invalid_term');
  if (!Array.isArray(sections) || sections.length > 10000) throw invalid('sections', 'invalid_sections');
  const courses = new Map();
  const lowestCrns = new Map();
  const unique = new Map();
  const uint = value => Number.isInteger(value) && value >= 0 && value <= 4294967295;
  for (const [index, row] of sections.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw invalid('row', 'invalid_row', index);
    const match = typeof row.course === 'string' && /^([A-Z][A-Z0-9]{0,9})\s+(\d[A-Z0-9]{0,19})$/.exec(row.course);
    if (!match) throw invalid('course', 'invalid_course', index);
    if (match[1] !== subject) throw invalid('course', 'subject_mismatch', index);
    let title = typeof row.title === 'string' ? row.title.trim().replace(/\s+/g, ' ') : '';
    const prefix = `${match[1]} ${match[2]} - `;
    if (title.startsWith(prefix)) title = title.slice(prefix.length);
    else if (title === prefix.trimEnd()) title = '';
    if (!title.trim() || [...title].length > 255) throw invalid('title', 'invalid_title', index);
    if (typeof row.crn !== 'string' || !/^\d{5}$/.test(row.crn)) throw invalid('crn', 'invalid_crn', index);
    if (typeof row.section !== 'string' || !row.section.trim() || [...row.section].length > 20) {
      throw invalid('section', 'invalid_section', index);
    }
    if (!['OPEN', 'CLOSED', 'CANCELLED'].includes(row.status)) throw invalid('status', 'invalid_status', index);
    if (!uint(row.max_enrollment)) throw invalid('max_enrollment', 'invalid_enrollment', index);
    if (!uint(row.current_enrollment)) throw invalid('current_enrollment', 'invalid_enrollment', index);
    const courseNumber = match[2];
    const section = { crn: row.crn, courseNumber, title, section_number: row.section,
      capacity: row.max_enrollment, enrolled: row.current_enrollment, status: row.status };
    if (unique.has(row.crn) && JSON.stringify(unique.get(row.crn)) !== JSON.stringify(section)) {
      throw invalid('crn', 'conflicting_crn', index);
    }
    unique.set(row.crn, section);
    // Distinct sections may have different valid titles. Five-digit CRNs sort
    // lexically in numeric order; choose the same representative in any row order.
    if (!lowestCrns.has(courseNumber) || row.crn < lowestCrns.get(courseNumber)) {
      lowestCrns.set(courseNumber, row.crn);
      courses.set(courseNumber, title);
    }
  }
  return { subject, term, courses, sections: [...unique.values()] };
}

async function synchronize(pool, snapshot) {
  const { subject, term, courses, sections } = snapshot;
  // Serialize writes for this department/term across backend instances.
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
        'SELECT subject, status, is_active FROM Sections WHERE term = ? AND crn = ? FOR UPDATE', [term, section.crn]);
      if (existing && existing.subject !== subject) throw fail(409, 'CRN belongs to another subject');
      // A returning section establishes a new baseline, not an availability transition.
      if (existing && Number(existing.is_active) === 1 && existing.status !== section.status) statusChanges++;
      await connection.execute(`INSERT INTO Sections
        (subject, term, crn, section_number, capacity, enrolled, status, course_id, last_checked_at, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, TRUE)
        ON DUPLICATE KEY UPDATE section_number = VALUES(section_number), capacity = VALUES(capacity),
          enrolled = VALUES(enrolled), status = VALUES(status), course_id = VALUES(course_id),
          last_checked_at = CURRENT_TIMESTAMP, is_active = TRUE`,
      [subject, term, section.crn, section.section_number, section.capacity, section.enrolled,
        section.status, courseIds.get(section.courseNumber)]);
    }
    // Structural validation cannot prove Banner returned every section. Preserve
    // omitted rows exactly; only explicit observations update/reactivate sections.
    // Department completion records accepted work, not upstream completeness.
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
  router.use(['/department', '/targets'], (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!expected) return res.status(503).json({ error: 'Department synchronization is not configured' });
    if (process.env.APP_ENV === 'production' && !req.secure) return res.status(400).json({ error: 'HTTPS required' });
    const match = /^Bearer ([A-Za-z0-9._~+\/-]+=*)$/i.exec(req.get('Authorization') || '');
    if (!timingSafeEqual(digest(match?.[1] || ''), expected) || !match) {
      return res.status(401).json({ error: 'Invalid checker credentials' });
    }
    next();
  });
  router.get('/targets', async (req, res) => {
    if (Object.keys(req.query).some(key => key !== 'watched_only') ||
        (req.query.watched_only !== undefined && req.query.watched_only !== 'true')) {
      return res.status(400).json({ error: 'Invalid targets parameters' });
    }
    const [watched] = await pool.execute(`SELECT DISTINCT s.subject, s.term
      FROM Sections s INNER JOIN Watchlists w ON w.section_id = s.id
      ORDER BY s.subject, s.term`);
    const targets = new Map();
    for (const { subject, term } of watched) {
      targets.set(`${subject}:${term}`, { subject, term });
    }
    res.json({ targets: [...targets.values()] });
  });
  router.post('/department', (req, res, next) => {
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
    next();
  }, express.json({ limit: '5mb' }), async (req, res, next) => {
    try {
      res.json(await synchronize(pool, validate(req.body)));
    } catch (error) {
      if (error.validation) {
        // Only server-defined fields and a numeric index; never log the payload.
        console.warn(JSON.stringify({ event: 'sync_validation_failed', ...error.validation }));
        return res.status(400).json({ error: error.message, validation: error.validation });
      }
      if (error.status) return res.status(error.status).json({ error: error.message });
      next(error);
    }
  });
  return router;
};
