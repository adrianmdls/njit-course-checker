# Express Backend

Express provides the authentication API and database health check. Nginx forwards `/api/` requests to `backend:3000`, and Express uses a shared mysql2 connection pool to reach MariaDB at `db:3306` over the Compose network. The backend has no published host port.

For installation, environment setup, and database initialization, see the [root README](../README.md).

## API Endpoints

| Method | Path | Request / result |
|---|---|---|
| GET | `/api/health` | Runs `SELECT 1`; returns `200` when connected or `503` when unavailable |
| POST | `/api/auth/register` | `{username, email, password}`; creates an account (`201`) |
| POST | `/api/auth/login` | `{identifier, password}`; username or email login, returns user details (`200`) or invalid credentials (`401`) |
| POST | `/api/auth/logout` | `{}`; destroys the session and clears the cookie (`204`) |
| GET | `/api/auth/me` | Returns the current user (`200`) or unauthenticated/expired session (`401`) |

Registration requires a username of 3–50 letters, digits, or underscores and a password of 15–128 Unicode code points. Invalid registration input returns `400`; duplicate username/email returns `409`.

POST requests require JSON, an `Origin` matching `APP_ORIGIN`, and `X-Requested-With: NJIT-Course-Checker`. The React request helper supplies the application headers; the browser supplies Origin.

## Authentication

Passwords are hashed with Argon2id. Login regenerates the session ID; MariaDB stores session data while an HttpOnly, SameSite=Lax cookie identifies the session. Sessions survive backend restarts, expire after 30 minutes idle or eight hours total, and are destroyed on logout. Registration does not automatically log users in.

Email verification and password reset are not implemented; unverified users may log in. Login and registration are rate limited.

## Configuration Notes

Compose supplies these backend variables:

| Variable | Purpose |
|---|---|
| `DB_HOST`, `DB_PORT` | Database address (`db:3306` in Compose) |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Database name and credentials |
| `PORT` | Express listening port (`3000`) |
| `APP_ENV` | `development` permits local HTTP; `production` requires HTTPS and Secure cookies |
| `APP_ORIGIN` | Exact browser origin, without a trailing slash; defaults to `http://localhost:8080` |
| `SESSION_SECRET` | Required signing secret, at least 32 bytes; changing it invalidates existing cookies |

The `sessions` table must exist before startup; MariaDB initializes it automatically for new Compose database volumes. Existing volumes require any missing migrations to be applied manually. Express does not create the table. `API_SCHEME` configures Nginx's forwarded protocol, not TLS itself. Keep the local values from `.env.example` for the Compose demo.
