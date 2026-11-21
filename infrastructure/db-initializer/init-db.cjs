const { createHash, timingSafeEqual } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { isIP } = require('node:net');
const { join } = require('node:path');
const mysql = require('mysql2/promise');

const APP_USER = 'njit_app';
const ACCOUNT = "'njit_app'@'%'";
const GRANTS = {
  Users: ['SELECT', 'INSERT'],
  Courses: ['SELECT', 'INSERT', 'UPDATE'],
  Sections: ['SELECT', 'INSERT', 'UPDATE'],
  DepartmentSyncs: ['SELECT', 'INSERT', 'UPDATE'],
  sessions: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  Watchlists: ['SELECT', 'INSERT', 'DELETE'],
};

class InitializationError extends Error {}

function credentials(name) {
  const raw = process.env[name];
  delete process.env[name];
  let secret;
  try {
    secret = JSON.parse(raw);
  } catch {
    throw new InitializationError(`Missing or invalid injected ${name} JSON.`);
  }
  const { username, password } = secret ?? {};
  if (![username, password].every(value => typeof value === 'string' && value.trim())) {
    throw new InitializationError(`${name} requires a username and password.`);
  }
  return { user: username, password };
}

function createStatements(database) {
  const [use, ...statements] = readFileSync(join(__dirname, '01-schema.sql'), 'utf8')
    .replace(/^\s*--[^\r\n]*/gm, '').split(';').map(sql => sql.trim()).filter(Boolean);
  if (!/^[a-z_]+$/.test(database) || use !== `USE ${database}`) {
    throw new InitializationError('DB_NAME must match the packaged schema.');
  }
  const tables = new Set();
  const creates = statements.map(sql => {
    const table = /^CREATE TABLE IF NOT EXISTS ([A-Za-z]+) \([\s\S]+\) ENGINE=InnoDB$/.exec(sql)?.[1];
    if (!table || !Object.hasOwn(GRANTS, table) || tables.has(table)) {
      throw new InitializationError('Unexpected statement in 01-schema.sql.');
    }
    tables.add(table);
    // Reject a concurrent external CREATE if a table appears after the preflight.
    return sql.replace('CREATE TABLE IF NOT EXISTS ', 'CREATE TABLE ');
  });
  if (tables.size !== Object.keys(GRANTS).length) {
    throw new InitializationError('The schema and table grants disagree.');
  }
  return creates;
}

async function schemaFingerprint(connection, creates) {
  const digest = createHash('sha256').update(creates.join(';\n'));
  for (const table of Object.keys(GRANTS).sort()) {
    const [rows] = await connection.query(`SHOW CREATE TABLE \`${table}\``);
    const definition = rows[0][1];
    // The next ID is row-dependent and is excluded from the definition hash.
    digest.update('\0' + definition.replace(/(\n\) ENGINE=InnoDB) AUTO_INCREMENT=\d+/, '$1'));
  }
  return `njit-db-init:${digest.digest('hex')}`;
}

async function prepareSchema(connection, creates) {
  const [[[stamp]]] = await connection.query(
    'SELECT SCHEMA_COMMENT FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()');
  const [tables] = await connection.query('SHOW FULL TABLES');
  const [[[unexpectedObjects]]] = await connection.query(
    `SELECT EXISTS (SELECT 1 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE())
         OR EXISTS (SELECT 1 FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE())
         OR EXISTS (SELECT 1 FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE())`);
  if (unexpectedObjects) {
    throw new InitializationError('Unexpected triggers, routines, or events in the application database.');
  }

  if (tables.length === 0 && !stamp) {
    for (const sql of creates) await connection.query(sql);
    await connection.query('ALTER DATABASE COMMENT = ?', [await schemaFingerprint(connection, creates)]);
    return;
  }
  if (!stamp || tables.length !== Object.keys(GRANTS).length ||
      tables.some(([name, type]) => !Object.hasOwn(GRANTS, name) || type !== 'BASE TABLE') ||
      stamp !== await schemaFingerprint(connection, creates)) {
    throw new InitializationError('The application schema is incomplete, unrecognized, or changed. Review it before retrying.');
  }
}

async function existingGrants(connection, database, verifier) {
  const [[usage, ...grants]] = await connection.query(`SHOW GRANTS FOR ${ACCOUNT}`);
  const account = /^GRANT USAGE ON \*\.\* TO `njit_app`@`%` IDENTIFIED BY PASSWORD '(\*[0-9A-F]{40})'( REQUIRE SSL)?$/.exec(usage?.[0]);
  if (!account) throw new InitializationError('Unexpected authentication, TLS settings, or global grants for njit_app.');
  if (!timingSafeEqual(Buffer.from(account[1]), Buffer.from(verifier))) {
    throw new InitializationError('The existing njit_app password differs from the application secret.');
  }

  const current = {};
  for (const [grant] of grants) {
    const match = /^GRANT ([A-Z, ]+) ON `([a-z_]+)`\.`([A-Za-z]+)` TO `njit_app`@`%`$/.exec(grant);
    if (!match || match[2] !== database || !Object.hasOwn(GRANTS, match[3])) {
      throw new InitializationError('Unexpected grant or role for njit_app.');
    }
    const privileges = match[1].split(', ');
    if (privileges.some(privilege => !GRANTS[match[3]].includes(privilege))) {
      throw new InitializationError('The njit_app account has privileges outside its allowed table grants.');
    }
    current[match[3]] = privileges;
  }
  return { tlsRequired: Boolean(account[2]), current };
}

async function initialize() {
  const master = credentials('MASTER_DB_SECRET');
  const application = credentials('APP_DB_SECRET');
  if (application.user !== APP_USER || application.password.length < 32) {
    throw new InitializationError('APP_DB_SECRET requires username njit_app and at least 32 password characters.');
  }
  const { DB_HOST: host, DB_PORT: port, DB_NAME: database } = process.env;
  if (!host || isIP(host) || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) ||
      !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new InitializationError('Set DB_HOST to the RDS DNS hostname and DB_PORT to its port.');
  }
  const creates = createStatements(database);
  const options = {
    host, port: Number(port), database, connectTimeout: 5000, rowsAsArray: true,
    ssl: { ca: readFileSync(join(__dirname, 'rds-ca.pem')), rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' },
  };
  // Send MariaDB's native verifier in CREATE USER, keeping plaintext out of SQL.
  const firstHash = createHash('sha1').update(application.password).digest();
  const verifier = '*' + createHash('sha1').update(firstHash).digest('hex').toUpperCase();

  const connection = await mysql.createConnection({ ...options, ...master });
  try {
    const [[[locked]]] = await connection.query('SELECT GET_LOCK(?, 5)', [`${database}:initialize`]);
    if (locked !== 1) throw new InitializationError('Could not acquire the database initialization lock.');
    const [publicGrants] = await connection.query('SHOW GRANTS FOR PUBLIC');
    if (publicGrants.length) throw new InitializationError('Review MariaDB PUBLIC grants before initialization.');
    const [hosts] = await connection.query('SELECT Host FROM mysql.user WHERE User = ?', [APP_USER]);
    if (hosts.some(([name]) => name !== '%')) throw new InitializationError('Unexpected host account for njit_app.');
    const { tlsRequired, current } = hosts.length ? await existingGrants(connection, database, verifier) : { current: {} };

    await prepareSchema(connection, creates);
    if (!hosts.length) {
      await connection.query(`CREATE USER ${ACCOUNT} IDENTIFIED VIA mysql_native_password USING ? REQUIRE SSL`, [verifier]);
    } else if (!tlsRequired) {
      await connection.query(`ALTER USER ${ACCOUNT} REQUIRE SSL`);
    }
    for (const [table, allowed] of Object.entries(GRANTS)) {
      const missing = allowed.filter(privilege => !current[table]?.includes(privilege));
      if (missing.length) {
        await connection.query(`GRANT ${missing.join(', ')} ON \`${database}\`.\`${table}\` TO ${ACCOUNT}`);
      }
    }
    const app = await mysql.createConnection({ ...options, ...application });
    try {
      const [[[account]]] = await app.query('SELECT CURRENT_USER()');
      if (account !== 'njit_app@%') throw new InitializationError('The application login resolved to an unexpected account.');
      for (const table of Object.keys(GRANTS)) await app.query(`SELECT * FROM \`${table}\` LIMIT 0`);
    } finally {
      app.destroy();
    }
  } finally {
    connection.destroy();
  }
}

setTimeout(() => {
  console.error('Database initialization timed out. Review the database before retrying.');
  process.exit(1);
}, 60_000).unref();

initialize().then(() => console.log('Database schema and TLS application login verified.')).catch(error => {
  // Driver messages may contain SQL and JSON parse errors can include secret contents.
  const code = /^[A-Z][A-Z0-9_]*$/.test(error.code) ? ` (${error.code})` : '';
  console.error(error instanceof InitializationError ? error.message : `Database initialization failed${code}.`);
  process.exitCode = 1;
});
