const express = require('express');

function validate(params) {
  const allowed = ['term', 'subject', 'query', 'status', 'sort', 'order', 'limit', 'offset'];
  if (Object.entries(params).some(([key, value]) => !allowed.includes(key) || typeof value !== 'string')) return null;
  const { term, status, sort = 'course', order = 'asc', limit = '50', offset = '0' } = params;
  let { subject, query } = params;
  if (typeof term !== 'string' || !/^\d{4}(10|50|90|95)$/.test(term) ||
      (subject !== undefined && !/^[A-Z][A-Z0-9]{0,9}$/.test(subject)) ||
      (status !== undefined && !['OPEN', 'CLOSED', 'CANCELLED'].includes(status)) ||
      !['course', 'crn', 'availability'].includes(sort) || !['asc', 'desc'].includes(order) ||
      !/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100 ||
      !/^\d{1,10}$/.test(offset) || Number(offset) > 2147483647) return null;
  let prefix;
  if (query !== undefined) {
    if (query.length > 100) return null;
    query = query.trim().replace(/\s+/g, ' ').toUpperCase();
    const match = /^(?:([A-Z][A-Z0-9]{0,9}) )?(\d[A-Z0-9]{0,19})$/.exec(query);
    if (!match || (subject && match[1] && subject !== match[1])) return null;
    subject = subject || match[1];
    prefix = match[2];
  }
  return { term, subject, prefix, status, sort, order, limit: Number(limit), offset: Number(offset) };
}

module.exports = function createCourses(pool, auth) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (process.env.APP_ENV === 'production' && !req.secure) return res.status(400).json({ error: 'HTTPS required' });
    next();
  });
  // Reuse the very same session initializer and user lookup as /api/auth.
  router.use(auth.sessionMiddleware, auth.requireAuth);
  router.get('/', async (req, res) => {
    const filters = validate(req.query);
    if (!filters) return res.status(400).json({ error: 'Invalid course search parameters' });
    const { term, subject, prefix, status, sort, order, limit, offset } = filters;
    const conditions = ['s.term = ?'];
    const values = [term];
    for (const [condition, value] of [
      ['c.subject = ?', subject], ['c.course_number LIKE ?', prefix === undefined ? undefined : `${prefix}%`],
      ['s.status = ?', status],
    ]) {
      if (value !== undefined) { conditions.push(condition); values.push(value); }
    }
    const from = `FROM Sections s INNER JOIN Courses c ON s.course_id = c.id WHERE ${conditions.join(' AND ')}`;
    // Signed subtraction also supports over-enrolled sections. Unknown availability sorts last.
    const availability = '(CAST(s.capacity AS SIGNED) - CAST(s.enrolled AS SIGNED))';
    const columns = {
      course: ['c.subject', 'c.course_number', 's.section_number', 's.id'],
      crn: ['s.crn', 's.id'],
      availability: [availability, 'c.subject', 'c.course_number', 's.section_number', 's.id'],
    };
    const direction = order === 'asc' ? 'ASC' : 'DESC';
    const ordering = (sort === 'availability' ? [`${availability} IS NULL ASC`] : [])
      .concat(columns[sort].map(column => `${column} ${direction}`)).join(', ');
    const [[count]] = await pool.execute(`SELECT COUNT(*) AS total ${from}`, values);
    const [rows] = await pool.execute(`SELECT s.id, CONCAT(c.subject, ' ', c.course_number) AS course,
      c.subject, c.course_number, c.title, s.term, s.crn, s.section_number AS section,
      s.capacity AS max, s.enrolled AS now, s.status, UNIX_TIMESTAMP(s.last_checked_at) AS checked_epoch
      ${from} ORDER BY ${ordering} LIMIT ? OFFSET ?`, [...values, limit, offset]);
    const sections = rows.map(({ checked_epoch, ...row }) => ({ ...row,
      last_checked_at: checked_epoch === null ? null : new Date(Number(checked_epoch) * 1000).toISOString(),
    }));
    res.json({ sections, pagination: { limit, offset, total: Number(count.total) } });
  });
  return router;
};
