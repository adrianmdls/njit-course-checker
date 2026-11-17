# NJIT Course Availability Checker

An IT 610 project under development using Docker Compose to run a React/Nginx frontend, an Express backend, a MariaDB database, and a Python course availability checker.

The frontend sends `/api/` requests through Nginx to Express, which connects to MariaDB. The Python checker also reads and updates MariaDB. Docker networking connects the services internally.

## Current Functionality

- Account registration, login/logout, and session-based access to the dashboard.
- Express database health endpoint and authentication API.
- Python monitoring of database-configured sections, availability updates, local logs, and optional Discord notifications.

The dashboard currently displays mock course data. Course search and watchlist management are not yet connected to the Express API. An empty database has no sections to monitor.

## Banner department synchronization

Department snapshots now follow Banner → Python → Express → MariaDB. Set
`CHECKER_API_TOKEN` in `.env` to a separate random secret (generate with
`openssl rand -hex 32`). Compose passes the same token to the backend and checker.
`CHECKER_API_URL` is the backend base URL without `/api`; it defaults to
`http://backend:3000` inside Compose. A checker on a separate VM needs a reachable
HTTPS base URL and the same token. Requests retain certificate verification.
The direct Compose URL is for development; with `APP_ENV=production`, use the
trusted HTTPS proxy URL because Express rejects direct HTTP ingestion.

`sync_department(subject, term, data=None)` keeps its existing interface: it
fetches Banner when `data` is omitted, parses `parse_all_sections()`, and sends
the resulting list unchanged in `{subject, term, sections}`. Express handles
validation, transactions, upserts, and locking. Python uses a 5-second connection
timeout and a 30-second read timeout, raises safe errors on failures, and does
not follow redirects or automatically retry. Submit snapshots sequentially;
Express does not detect out-of-order data. The caller prints server-reported
course/section counts only after success.

This is an intermediate integration. The polling loop still uses MariaDB for
monitoring reads, individual section writes, and its legacy lock. Its HTTP sync
call runs **after releasing that lock**. The existing Python search helper also
delegates synchronization without holding a database lock; its cache reads are
still direct SQL. No new search functionality is included.

Commit 3 must address legacy monitoring membership and status ownership before
relying on this path as the final polling architecture. Ingestion links NULL
`course_id` rows to courses, so unwatched legacy rows no longer match
`get_sections_to_check()`. Watched rows remain eligible, but Python and Express
currently both update their statuses, and the returned change count is not a
notification event stream. Existing Discord behavior is unchanged. Moving the
HTTP call outside the legacy lock also leaves a gap between Banner fetch and
submission: avoid concurrent producers until the polling migration is complete.

Run the focused Python tests from the repository root with installed project
requirements:

```sh
python -m unittest discover -s tests -v
```

Alternatively, use the existing checker image and mount the checkout read-only:

```sh
docker compose build checker
docker run --rm -v "$PWD:/workspace:ro" -w /workspace \
  -e PYTHONDONTWRITEBYTECODE=1 njit-course-checker-checker \
  python -B -m unittest discover -s tests -v
```

## Project Structure

```text
njit-course-checker/
├── frontend/          # React application and Nginx configuration
├── backend/           # Express API
├── src/               # Python checker and database integration
├── database/
│   ├── init/          # Initial database schema
│   └── migrations/    # Additional schema changes
├── data/              # Persistent checker logs (excluded from Git)
├── docs/operations.md
├── compose.yaml
└── .env.example
```

## Quick Start

Requires Git, Docker with Compose v2, and internet access to build images. Host installations of Node.js, Python, and MariaDB are not required.

1. Clone the repository and copy the environment template:

   ```sh
   git clone https://github.com/adrianmdls/njit-course-checker.git
   cd njit-course-checker
   cp .env.example .env
   ```

2. Edit `.env` and set distinct `DB_ROOT_PASSWORD` and `DB_PASSWORD` values, plus separate `SESSION_SECRET` and `CHECKER_API_TOKEN` secrets. Generate each secret with `openssl rand -hex 32` (requires OpenSSL), then paste the result into `.env`.

   Keep the local defaults `APP_ENV=development`, `APP_ORIGIN=http://localhost:8080`, and `API_SCHEME=http`. `CHECK_INTERVAL` defaults to 600 seconds; `DISCORD_WEBHOOK_URL` is optional. Never commit `.env`, and keep the session secret stable across restarts. Local HTTP settings are for local use; production requires HTTPS.

3. Build and start the services:

   ```sh
   docker compose up -d --build --wait
   ```

   For a new database volume, MariaDB automatically runs the base schema and all three migrations in order. No manual migration commands are needed for a fresh installation.

   Open **http://localhost:8080**, register, and log in. Use `localhost` to match `APP_ORIGIN`. Check database connectivity at **http://localhost:8080/api/health**.

Existing database volumes do not automatically receive migrations. Back up and inspect an existing database, then apply only missing changes from `database/migrations/`. Do not blindly rerun `02-course-catalog.sql` if `Sections.course_id` already exists.

View service output with `docker compose logs -f`; stop the stack with `docker compose down`. MariaDB persists in a named volume, and checker logs persist in `data/`. **Do not use `docker compose down -v` unless you intend to delete the database.**

## Documentation

- [Operations](docs/operations.md): existing operational notes; still describes parts of the older checker setup and will be updated after Milestone 2.
- [Backend](backend/README.md): API endpoints, authentication, and backend configuration.
