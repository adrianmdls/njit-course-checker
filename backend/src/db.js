const mysql = require('mysql2/promise');
for (const name of ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD']) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}
module.exports = mysql.createPool({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME, user: process.env.DB_USER, password: process.env.DB_PASSWORD,
  connectionLimit: 5, waitForConnections: true, queueLimit: 10, connectTimeout: 5000,
});
