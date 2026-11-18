const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const argon2 = require('argon2');
const { rateLimit } = require('express-rate-limit');
const crypto = require('node:crypto');

module.exports = async function createAuth(pool) {
  const production = process.env.APP_ENV === 'production';
  if (!['development', 'production'].includes(process.env.APP_ENV)) throw new Error('Set APP_ENV');
  const origin = new URL(process.env.APP_ORIGIN).origin;
  if (process.env.APP_ORIGIN !== origin) throw new Error('APP_ORIGIN must be an exact origin');
  if (production && !origin.startsWith('https://')) throw new Error('Production requires HTTPS APP_ORIGIN');
  if (!process.env.SESSION_SECRET || Buffer.byteLength(process.env.SESSION_SECRET) < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 random bytes');
  }
  // The migration must be applied explicitly; do not create schema on startup.
  await pool.query('SELECT session_id, expires, data FROM sessions LIMIT 0');
  const store = new MySQLStore({ createDatabaseTable: false, endConnectionOnClose: false, clearExpired: false,
    expiration: 30 * 60 * 1000, checkExpirationInterval: 15 * 60 * 1000 }, pool);
  await store.onReady();
  // Catch cleanup errors so a database outage cannot cause an unhandled rejection.
  const cleanup = setInterval(() => {
    store.clearExpiredSessions().catch(error => console.error('Session cleanup failed:', error.code || 'UNKNOWN'));
  }, 15 * 60 * 1000);
  cleanup.unref();
  const cookieName = production ? '__Host-njit.sid' : 'njit.sid';
  const cookie = { httpOnly: true, sameSite: 'lax', secure: production, path: '/', maxAge: 30 * 60 * 1000 };
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (production && !req.secure) return res.status(400).json({ error: 'HTTPS required' });
    next();
  });
  // Same-origin JSON API: require both a custom header and an exact Origin on mutations.
  function requireMutation(req, res, next) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('Origin') !== origin || req.get('X-Requested-With') !== 'NJIT-Course-Checker') {
      return res.status(403).json({ error: 'Invalid request origin' });
    }
    if (!req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
    next();
  }
  router.use(requireMutation);
  const limiter = (limit, windowMs) => rateLimit({ windowMs, limit, standardHeaders: 'draft-8',
    legacyHeaders: false, message: { error: 'Too many attempts; try again later' } });
  // Run before session access and expensive password hashing.
  router.use('/login', limiter(10, 15 * 60 * 1000));
  router.use('/register', limiter(5, 60 * 60 * 1000));
  router.use(express.json({ limit: '8kb' }));
  const sessionMiddleware = session({ name: cookieName, secret: process.env.SESSION_SECRET, store,
    resave: false, saveUninitialized: false, rolling: true, cookie });
  router.use(sessionMiddleware);
  const fields = 'id, username, email, email_verified, created_at';
  const safeUser = user => ({ ...user, email_verified: Boolean(user.email_verified) });
  const hashOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
  const dummyHash = await argon2.hash(crypto.randomBytes(32), hashOptions);
  const changeSession = (req, method) => new Promise((resolve, reject) => {
    req.session[method](error => error ? reject(error) : resolve());
  });
  async function requireAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Authentication required' });
    if (Date.now() - req.session.authenticatedAt >= 8 * 60 * 60 * 1000) {
      await changeSession(req, 'destroy');
      res.clearCookie(cookieName, { ...cookie, maxAge: undefined });
      return res.status(401).json({ error: 'Session expired' });
    }
    const [users] = await pool.execute(`SELECT ${fields} FROM Users WHERE id = ?`, [req.session.userId]);
    if (!users.length) {
      await changeSession(req, 'destroy');
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = safeUser(users[0]);
    next();
  }
  router.post('/register', async (req, res) => {
    const { username, email, password } = req.body || {};
    if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,50}$/.test(username) ||
        typeof email !== 'string' || email.trim().length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
        typeof password !== 'string' || [...password].length < 15 || [...password].length > 128) {
      return res.status(400).json({ error: 'Use a 3–50 character username (letters, numbers, underscores), a valid email, and a 15–128 character password.' });
    }
    const hash = await argon2.hash(password, hashOptions);
    try {
      await pool.execute('INSERT INTO Users (username, email, password_hash) VALUES (?, ?, ?)',
        [username, email.trim().toLowerCase(), hash]);
    } catch (error) {
      if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Unable to register with these details' });
      throw error;
    }
    res.status(201).json({ message: 'Account created. Please log in.' });
  });
  router.post('/login', async (req, res) => {
    const { identifier, password } = req.body || {};
    if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 255 ||
        typeof password !== 'string' || !password || [...password].length > 128) {
      return res.status(400).json({ error: 'Provide a username/email and password' });
    }
    const column = identifier.includes('@') ? 'email' : 'username';
    const [users] = await pool.execute(`SELECT ${fields}, password_hash FROM Users WHERE ${column} = ?`, [identifier.trim()]);
    const user = users[0];
    const valid = await argon2.verify(user?.password_hash || dummyHash, password);
    if (!user || !valid) return res.status(401).json({ error: 'Invalid username/email or password' });
    await changeSession(req, 'regenerate');
    req.session.userId = user.id;
    req.session.authenticatedAt = Date.now();
    await changeSession(req, 'save');
    delete user.password_hash;
    res.json({ user: safeUser(user) });
  });
  router.post('/logout', async (req, res) => {
    await changeSession(req, 'destroy');
    res.clearCookie(cookieName, { httpOnly: true, sameSite: 'lax', secure: production, path: '/' });
    res.sendStatus(204);
  });
  router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));
  return { router, sessionMiddleware, requireAuth, requireMutation, async close() {
    clearInterval(cleanup);
    await store.close();
  } };
};
