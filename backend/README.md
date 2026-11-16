# Express backend

## Files

- `src/server.js`: environment validation, database pool, health route, JSON error responses, and graceful shutdown.
- `package.json`: start command and the Express/mysql2 dependencies.
- `package-lock.json`: reproducible dependency versions for `npm ci`.
- `Dockerfile`: Node 24 Alpine image, production dependencies, and an unprivileged runtime user.
- `.dockerignore`: excludes local dependencies, environment files, and logs from the build context.

## Configuration and networking

Set `DB_PASSWORD` and `DB_ROOT_PASSWORD` in the root `.env` file using `.env.example` as a guide. Never commit secrets. Optional `BACKEND_PORT` defaults to 3000.

Compose supplies `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD` to the backend. All services share the existing default Compose network. Docker DNS resolves `db` to MariaDB, which listens on container port 3306 without publishing a host port. The backend starts after MariaDB's health check passes. The frontend and checker definitions are unchanged; Nginx does not yet proxy API requests.

The mysql2 pool opens connections as needed and reuses up to five connections. Each `pool.query` automatically borrows and releases a connection. Up to ten requests can wait when all connections are busy. Connection and query timeouts are five seconds. SIGTERM/SIGINT closes the HTTP server and pool, with a ten-second shutdown deadline.

## Run and verify

From the repository root:

```sh
docker compose up -d --build --wait backend
curl -i http://127.0.0.1:3000/api/health
docker compose logs backend
```

Use your configured `BACKEND_PORT` in URLs if changed. A successful `SELECT 1` returns HTTP 200 with `{"status":"ok","database":"connected"}`. Database failures return HTTP 503 with `{"status":"error","database":"unavailable"}`; database details and credentials are not returned. Unknown routes return HTTP 404.

To test an outage, briefly stop MariaDB (this also interrupts checker database access), test, and immediately restore it:

```sh
docker compose stop db
curl -i http://127.0.0.1:3000/api/health
docker compose start --wait db
curl -i http://127.0.0.1:3000/api/health
```

Always restore `db`, even if the request fails. No schema changes are required. Start the entire stack with `docker compose up -d --build`.
