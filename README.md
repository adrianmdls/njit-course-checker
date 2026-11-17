# NJIT Course Availability Checker

An IT 610 project under development using Docker Compose to run a React/Nginx frontend, an Express backend, a MariaDB database, and a Python course availability checker.

The frontend sends `/api/` requests through Nginx to Express, which connects to MariaDB. The Python checker fetches monitoring targets and submits Banner snapshots over authenticated HTTP; Express owns its MariaDB reads and writes. Docker networking connects the services internally.

## Current Functionality

- Account registration, login/logout, and session-based access to the dashboard.
- Express database health endpoint and authentication API.
- Sequential Python polling of watched and explicitly configured departments, with persistence and status-change detection in Express.
- Authenticated course-section search with term, department, course-prefix and status filters, sorting, and pagination.

React searches existing MariaDB records through `GET /api/courses`, using the
same session cookie as login. Search never fetches Banner or starts a sync.
Unsynchronized department/term combinations return no results.

The watchlist still uses local React state initialized with mock records. Add,
remove, and notification toggles are demo controls; they do not persist or update
backend Watchlists. Configure explicit monitoring targets to populate search
results in a fresh installation. Automatic notifications are not implemented.

## Banner department synchronization

Department snapshots now follow Banner → Python → Express → MariaDB. Set
`CHECKER_API_TOKEN` in `.env` to a separate random secret (generate with
`openssl rand -hex 32`). Compose passes the same token to the backend and checker.
`CHECKER_API_URL` is the backend base URL without `/api`; it defaults to
`http://backend:3000` inside Compose. A checker on a separate VM needs a reachable
HTTPS base URL and the same token. Requests retain certificate verification.
The direct Compose URL is for development; with `APP_ENV=production`, use the
trusted HTTPS proxy URL because Express rejects direct HTTP ingestion.

Python parses Banner snapshots and submits them to Express, which handles
validation, transactions, upserts, and locking. The standalone
`sync_department(subject, term, data=None)` helper uses the same HTTP API.

The checker retrieves `{targets: [{subject, term}]}` from
`GET /api/internal/sync/targets`, then fetches, parses, and submits a complete
Banner snapshot for each pair in sequence. Express derives targets from
Watchlists plus the backend-only `CHECKER_MONITORING_TARGETS` JSON setting:

```dotenv
CHECKER_MONITORING_TARGETS='[{"subject":"IT","term":"202690"},{"subject":"CS","term":"202690"}]'
```

The default is `[]`: watchlists alone determine polling. Multiple watched
sections/users in the same department/term produce one target. Explicit targets
remain active even without Watchlists or after ingestion creates course links.
Changing the configuration requires recreating the backend container. Invalid
configuration prevents backend startup without logging its contents.

**Before upgrading a legacy database**, explicitly list every manually monitored
department/term you want to retain. The schema has no monitoring flag, and NULL
`course_id` values do not reliably identify intent. Inspect candidates using this
read-only query and compare them with your known monitoring configuration:

```sql
SELECT DISTINCT s.subject, s.term
FROM Sections s
WHERE s.course_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM Watchlists w WHERE w.section_id = s.id);
```

Do not automatically classify every candidate as monitored. Previously linked
legacy rows cannot be recovered from this query; consult your configuration or
backups as needed. The retired `courses.json` sample used term `202690` (Fall
2026), CRN `94353` (`IT 610-101`), and CRN `91923` (`CS 288-005`). These are
historical examples, not current targets; the department/term equivalents appear
in the configuration example above. Moving monitoring configuration to explicit
targets requires no schema migration.

The polling process and `manual_check` use no Python SQL functions or database
credentials. `manual_check` retrieves targets and Banner snapshots but does not
submit them; it prints department summaries. `CHECK_INTERVAL` remains the wait
in seconds after each completed cycle (default 600). Failed Banner fetches,
empty/invalid snapshots, rejected submissions, and rolled-back transactions do
not advance synchronization timestamps. A client timeout is ambiguous: Express
may still commit successfully after the caller stops waiting.

Run only one checker instance. Submissions are synchronous, with no automatic
retries, background workers, or queues. Do not run standalone synchronization or
search-cache refreshes against the same departments concurrently: advisory locks
prevent overlapping writes but do not detect out-of-order snapshots.

Express now owns status comparisons and returns aggregate change counts. Python
logs department summaries; its previous per-section Discord transition
notifications and `notification.log` updates are inactive. Notification delivery
requires a backend-owned event design in a later commit. The standalone
`src.discord_notify` utility remains available for manual use.

`src/course_search.py` has no polling/frontend callers and remains an isolated
legacy command-line helper. Its cache reads in `src/database.py` still require
manually supplied `DB_*` credentials; these are no longer passed to the checker.
PyMySQL remains in requirements solely for that helper. React uses the Express
course-search API instead.

See the [smoke-test procedure](docs/banner-smoke-test.md) for Python unit tests,
disposable pipeline tests, real React/Nginx/backend browser verification, and
local/VMware checks. Automated tests use deterministic Banner fixtures; live
Banner requests are optional. Backend test commands are in the
[backend guide](backend/README.md#tests).

## Project Structure

```text
njit-course-checker/
├── frontend/          # React application and Nginx configuration
├── backend/           # Express API
├── src/               # Python HTTP checker and retained legacy helpers
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

   Keep the local defaults `APP_ENV=development`, `APP_ORIGIN=http://localhost:8080`, and `API_SCHEME=http`. Set `CHECKER_MONITORING_TARGETS` to the departments/terms you want synchronized; its default `[]` leaves a fresh installation idle. `CHECK_INTERVAL` defaults to 600 seconds. Never commit `.env`, and keep the session secret stable across restarts. Local HTTP settings are for local use; production requires HTTPS.

3. Build and start the services:

   ```sh
   docker compose up -d --build --wait
   ```

   For a new database volume, MariaDB automatically runs the current base schema. No manual migration commands are needed for a fresh installation.

   Open **http://localhost:8080**, register, and log in. Use `localhost` to match `APP_ORIGIN`. Check database connectivity at **http://localhost:8080/api/health**.

Existing database volumes do not automatically receive migrations. Back up and inspect an existing database, then apply only missing changes from `database/migrations/`. Do not blindly rerun `02-course-catalog.sql` if `Sections.course_id` already exists.

View service output with `docker compose logs -f`; stop the stack with `docker compose down`. MariaDB persists in a named volume, and checker logs persist in `data/`. **Do not use `docker compose down -v` unless you intend to delete the database.**

## Documentation

- [Banner smoke tests](docs/banner-smoke-test.md): deterministic integration tests and local/VMware verification.
- [Operations](docs/operations.md): routine commands, term codes, logs, and manual checks.
- [Backend](backend/README.md): API endpoints, authentication, and backend configuration.
- [Frontend](frontend/README.md): local React development, lint, and build commands.
