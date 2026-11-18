const express = require('express');

const validId = value => Number.isInteger(value) && value > 0 && value <= 4294967295;

module.exports = function createWatchlist(pool, auth) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (process.env.APP_ENV === 'production' && !req.secure) return res.status(400).json({ error: 'HTTPS required' });
    next();
  });
  router.use(auth.sessionMiddleware, auth.requireAuth, auth.requireMutation);
  router.use(express.json({ limit: '1kb' }));
  router.use((req, res, next) => {
    if (Object.keys(req.query).length) return res.status(400).json({ error: 'Watchlist does not accept query parameters' });
    next();
  });
  router.get('/', async (req, res) => {
    // LEFT JOIN keeps existing watches of legacy, unlinked Sections visible.
    const [rows] = await pool.execute(`SELECT s.id AS section_id,
      COALESCE(CONCAT(c.subject, ' ', c.course_number), NULLIF(w.course_number_label, ''), s.subject) AS course,
      c.title, s.subject, s.term, s.crn, s.section_number AS section,
      s.capacity AS max, s.enrolled AS now, s.status, s.is_active, UNIX_TIMESTAMP(s.last_checked_at) AS checked_epoch
      FROM Watchlists w INNER JOIN Sections s ON s.id = w.section_id
      LEFT JOIN Courses c ON c.id = s.course_id
      WHERE w.user_id = ? ORDER BY s.term DESC, s.subject, c.course_number, s.section_number, s.id`, [req.user.id]);
    res.json({ sections: rows.map(({ checked_epoch, ...row }) => ({ ...row,
      is_active: Number(row.is_active) === 1,
      last_checked_at: checked_epoch === null ? null : new Date(Number(checked_epoch) * 1000).toISOString(),
    })) });
  });
  router.post('/', async (req, res) => {
    const body = req.body;
    if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || !validId(body.section_id)) {
      return res.status(400).json({ error: 'Provide only a valid numeric section_id' });
    }
    try {
      // Existence check and insertion are one statement; the unique constraint
      // handles concurrent duplicate additions without suppressing other errors.
      const [result] = await pool.execute(`INSERT INTO Watchlists (user_id, section_id)
        SELECT ?, id FROM Sections WHERE id = ?`, [req.user.id, body.section_id]);
      if (!result.affectedRows) return res.status(404).json({ error: 'Section not found' });
      res.status(201).json({ section_id: body.section_id });
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Section is already watched' });
      if (error.code === 'ER_NO_REFERENCED_ROW_2') return res.status(404).json({ error: 'Section not found' });
      throw error;
    }
  });
  router.delete('/:sectionId', async (req, res) => {
    const { sectionId } = req.params;
    if (!/^[1-9]\d{0,9}$/.test(sectionId) || !validId(Number(sectionId)) ||
        (req.body !== undefined && (!req.body || Array.isArray(req.body) || Object.keys(req.body).length))) {
      return res.status(400).json({ error: 'Provide a valid section ID and no body fields' });
    }
    const [result] = await pool.execute('DELETE FROM Watchlists WHERE user_id = ? AND section_id = ?',
      [req.user.id, Number(sectionId)]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Section is not in your watchlist' });
    res.sendStatus(204);
  });
  return router;
};
