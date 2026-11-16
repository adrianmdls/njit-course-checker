const express = require('express');
const mysql = require('mysql2/promise');

for (const name of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionLimit: 5,
  waitForConnections: true,
  queueLimit: 10,
  connectTimeout: 5000,
});

const app = express();
app.disable('x-powered-by');

app.get('/api/health', async (req, res) => {
  try {
    await pool.query({ sql: 'SELECT 1', timeout: 5000 });
    res.json({ status: 'ok', database: 'connected' });
  } catch (error) {
    console.error('Database health check failed:', error.code || 'UNKNOWN');
    res.status(503).json({ status: 'error', database: 'unavailable' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((error, req, res, next) => {
  console.error('Request failed:', error.code || 'UNKNOWN');
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
  console.log('Backend listening');
});

async function shutdown() {
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  server.close(async () => {
    try {
      await pool.end();
      clearTimeout(deadline);
    } catch {
      process.exitCode = 1;
    }
  });
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
