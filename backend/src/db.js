const { X509Certificate } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { isIP } = require('node:net');
const mysql = require('mysql2/promise');

for (const name of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const caFile = process.env.DB_TLS_CA_FILE;
let ssl;
if (caFile !== undefined) {
  // mysql2 skips its explicit hostname check for IP literals.
  if (isIP(process.env.DB_HOST)) throw new Error('DB_HOST must be a DNS hostname when DB_TLS_CA_FILE is set.');

  let ca;
  try {
    ca = readFileSync(caFile, 'utf8');
  } catch {
    throw new Error('Unable to read DB_TLS_CA_FILE.');
  }
  try {
    // Validate each certificate because the pool opens connections lazily.
    const pem = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g;
    const certificates = ca.match(pem);
    if (!certificates || ca.replace(pem, '').trim()) throw new Error();
    for (const certificate of certificates) new X509Certificate(certificate);
  } catch {
    throw new Error('DB_TLS_CA_FILE must contain a valid PEM certificate or bundle.');
  }
  ssl = { ca, rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' };
}

module.exports = mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  connectionLimit: 5, waitForConnections: true, queueLimit: 10, connectTimeout: 5000,
  ...(ssl && { ssl }),
});
