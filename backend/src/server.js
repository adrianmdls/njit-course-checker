const express = require('express');
const pool = require('./db');
const createAuth = require('./auth');

async function main() {
  const app = express();
  app.disable('x-powered-by');
  // Exactly one trusted hop: Nginx. Backend has no published host port.
  app.set('trust proxy', 1);
  const auth = await createAuth(pool);
  app.use('/api/auth', auth.router);

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
    const databaseError = /^(ER_|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|PROTOCOL_)/.test(error.code || '') || error.message === 'Queue limit reached.';
    const status = error.type === 'entity.too.large' ? 413 : error.type === 'entity.parse.failed' ? 400 : databaseError ? 503 : 500;
    res.status(status).json({ error: status === 400 ? 'Invalid JSON' : status === 413 ? 'Request too large' : status === 503 ? 'Service temporarily unavailable' : 'Internal server error' });
  });

  const server = app.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => {
    console.log('Backend listening');
  });

  async function shutdown() {
    const deadline = setTimeout(() => process.exit(1), 10000);
    deadline.unref();
    server.close(async () => {
      try {
        await auth.close();
        await pool.end();
        clearTimeout(deadline);
      } catch {
        process.exitCode = 1;
      }
    });
  }
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

}
main().catch(error => {
  console.error('Backend startup failed:', error.code || error.message);
  process.exit(1);
});
