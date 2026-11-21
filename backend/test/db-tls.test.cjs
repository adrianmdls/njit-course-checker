const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test, after } = require('node:test');
const { rootCertificates } = require('node:tls');

const fixtureDir = mkdtempSync(join(tmpdir(), 'njit-db-tls-'));
after(() => rmSync(fixtureDir, { recursive: true, force: true }));
const certificateBundle = rootCertificates.slice(0, 2).join('\n');
const caFile = join(fixtureDir, 'ca.pem');
const invalidCaFile = join(fixtureDir, 'invalid-ca.pem');
writeFileSync(caFile, certificateBundle);
writeFileSync(invalidCaFile, '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n');

function loadPool(settings = {}) {
  const modulePath = require.resolve('../src/db');
  const previousEnv = process.env;
  const env = { ...previousEnv, DB_HOST: 'db', DB_NAME: 'njit_course_checker', DB_USER: 'test-user', DB_PASSWORD: 'test-password' };
  delete env.DB_PORT;
  delete env.DB_TLS_CA_FILE;
  process.env = { ...env, ...settings };
  delete require.cache[modulePath];
  try {
    return require(modulePath);
  } finally {
    process.env = previousEnv;
    delete require.cache[modulePath];
  }
}

test('leaving DB_TLS_CA_FILE unset preserves the existing plaintext pool configuration', t => {
  const pool = loadPool({ DB_HOST: '127.0.0.1' });
  t.after(() => pool.end());
  const config = pool.pool.config;
  assert.equal(config.connectionConfig.ssl, false);
  assert.equal(config.connectionConfig.host, '127.0.0.1');
  assert.equal(config.connectionConfig.port, 3306);
  assert.equal(config.connectionConfig.connectTimeout, 5000);
  assert.equal(config.connectionLimit, 5);
  assert.equal(config.waitForConnections, true);
  assert.equal(config.queueLimit, 10);
});

test('the pool uses the PEM bundle with certificate and hostname checks enabled', t => {
  const pool = loadPool({ DB_TLS_CA_FILE: caFile });
  t.after(() => pool.end());
  assert.deepEqual(pool.pool.config.connectionConfig.ssl, {
    ca: certificateBundle, rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2',
  });
});

test('a missing, empty-path, or invalid CA fails before opening a connection', () => {
  assert.throws(() => loadPool({ DB_TLS_CA_FILE: join(fixtureDir, 'missing.pem') }), /Unable to read DB_TLS_CA_FILE/);
  assert.throws(() => loadPool({ DB_TLS_CA_FILE: '' }), /Unable to read DB_TLS_CA_FILE/);
  assert.throws(() => loadPool({ DB_TLS_CA_FILE: invalidCaFile }), /valid PEM certificate or bundle/);
});

test('TLS mode rejects IP literals that mysql2 would not explicitly hostname-check', () => {
  assert.throws(() => loadPool({ DB_HOST: '127.0.0.1', DB_TLS_CA_FILE: caFile }), /DB_HOST must be a DNS hostname/);
});

const trustedCa = process.env.TEST_DB_TLS_CA_FILE;
test('the backend pool requires verified TLS with a live MariaDB server', {
  skip: !trustedCa && 'Set TEST_DB_TLS_CA_FILE to a disposable MariaDB server CA',
}, async t => {
  const { TEST_DB_HOST: host, TEST_DB_PORT: port, TEST_DB_TLS_WRONG_HOST: wrongHost } = process.env;
  assert.ok(host && port && wrongHost && host !== wrongHost, 'Set TEST_DB_HOST, TEST_DB_PORT, and TEST_DB_TLS_WRONG_HOST');
  const settings = { DB_HOST: host, DB_PORT: port, DB_USER: 'root', DB_PASSWORD: process.env.TEST_DB_PASSWORD || 'test-only-password' };
  const cipher = async pool => (await pool.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'"))[0][0].Value;

  await t.test('a trusted server with a matching DNS name negotiates TLS', async t => {
    const pool = loadPool({ ...settings, DB_TLS_CA_FILE: trustedCa });
    t.after(() => pool.end());
    assert.ok(await cipher(pool));
  });

  await t.test('an untrusted CA aborts instead of using an available plaintext connection', async t => {
    const plaintext = loadPool(settings);
    const tls = loadPool({ ...settings, DB_TLS_CA_FILE: caFile });
    t.after(() => Promise.all([plaintext.end(), tls.end()]));
    assert.equal(await cipher(plaintext), '');
    await assert.rejects(cipher(tls), { code: 'HANDSHAKE_SSL_ERROR' });
  });

  await t.test('a hostname mismatch aborts instead of using an available plaintext connection', async t => {
    const plaintext = loadPool({ ...settings, DB_HOST: wrongHost });
    const tls = loadPool({ ...settings, DB_HOST: wrongHost, DB_TLS_CA_FILE: trustedCa });
    t.after(() => Promise.all([plaintext.end(), tls.end()]));
    assert.equal(await cipher(plaintext), '');
    await assert.rejects(cipher(tls), { code: 'HANDSHAKE_SSL_ERROR' });
  });
});
