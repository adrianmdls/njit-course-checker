# NJIT Course Availability Checker

An IT 610 project under development using Docker Compose to run a React/Nginx frontend, an Express backend, a MariaDB database, and a Python course availability checker.

The frontend sends `/api/` requests through Nginx to Express, which connects to MariaDB. The Python checker fetches monitoring targets and submits Banner snapshots over authenticated HTTP; Express owns its MariaDB reads and writes. Docker networking connects the services internally.

## Current Functionality

- Account registration, login/logout, and session-based access to the dashboard.
- Express database health endpoint and authentication API.
- Half-hourly department rotation and ten-minute watched synchronization, sharing sequential Banner access and Express persistence.
- Authenticated course-section search with term, department, course-prefix and status filters, sorting, and pagination.

React searches existing MariaDB records through `GET /api/courses`, using the
same session cookie as login. Search never fetches Banner or starts a sync.
Unsynchronized department/term combinations return no results. Search and catalog
options exclude inactive sections; existing watches retain them as Unavailable.
See [section activity and migration instructions](docs/section-activity.md) before
deploying against an existing database volume. Accepted responses update only
observed sections. Omitted sections, including their activity/status and last-seen
timestamps, remain unchanged because Banner completeness is unverified. Historical
statuses can therefore become stale; absence is not evidence of removal or closure.
Empty snapshots also preserve activity. No new migration is needed for this policy.

Watchlists persist in MariaDB for the authenticated user. Search results show
whether each database section is already watched; Add and Remove use the session-
authenticated `/api/watchlist` API. Watched subject/term pairs enter the existing
priority synchronization targets and leave when their last watch is removed.
Configure one or two checker terms to populate search results naturally through
department rotation. Automatic notifications are not implemented.
See [Phase 3 watchlists](docs/phase-3-watchlists.md) for the API and verification.

## Banner department synchronization

Phase 1 hardening, department-list provenance, empty-response semantics and
remaining verification limits are documented in [the stabilization notes](docs/phase-1-sync.md).
Validated empty arrays now record nondestructive successful synchronization;
unrecognized empty markup remains an error.

Department snapshots now follow Banner → Python → Express → MariaDB. Set
`CHECKER_API_TOKEN` in `.env` to a separate random secret (generate with
`openssl rand -hex 32`). Compose passes the same token to the backend and checker.
`CHECKER_API_URL` is the backend base URL without `/api`; it defaults to
`http://backend:3000` inside Compose. A checker on a separate VM needs a reachable
HTTPS base URL and the same token. Requests retain certificate verification.
The direct Compose URL is for development; with `APP_ENV=production`, use the
trusted HTTPS proxy URL because Express rejects direct HTTP ingestion.

The scheduled Python checker parses Banner snapshots and submits them to Express
over HTTP. Express handles validation, transactions, upserts, and locking.

Set `CHECKER_TERMS` to a JSON array of one or two distinct Banner term strings,
for example `CHECKER_TERMS='["202690","202710"]'`. Missing/invalid configuration
prevents checker startup. There is no automatic term discovery or startup import.

Two threads in the checker run independent wall-clock loops:

- At **:00 and :30**, take the next subject from `src/departments.json` and sync
  each configured term unless that exact subject/term pair is watched. Advance
  once per executed slot, even if both terms are watched or a request fails.
- At **:05, :15, :25, :35, :45 and :55**, retrieve actual Watchlist pairs from
  `GET /api/internal/sync/targets?watched_only=true`, deduplicate and filter to
  NJIT subjects and configured terms, then sync each pair. Membership is checked
  again immediately before each fetch. Demoted pairs resume normal rotation.

One condition gate serializes Banner fetching, strict parsing and Express submission.
A due regular slot takes priority before the next watched request; an active
watched request may finish first.
`BANNER_REQUEST_DELAY` defaults to 5 seconds and cannot be smaller: it is the
minimum pause after a Banner request completes or fails before the next starts.
An active batch finishes; ticks missed while it runs are skipped, without queued
catch-up or aggressive retries. For 82 departments, an uninterrupted rotation
requires 41 hours. Large watched batches or slow requests can exceed ten minutes;
pacing and serialization take precedence. See [scheduler details](docs/phase-2-sync.md).

`data/rotation.json` stores the next subject and last completed regular slot using
atomic replacement and fsync. The cursor advances after all configured terms
have been handled, including watched exclusions and individual failures. A crash
or interruption mid-slot preserves the prior cursor for a safe idempotent retry.
Corrupt state is preserved and halts scheduling without a Docker restart loop;
see the [cursor recovery procedure](docs/phase-2-sync.md#cursor-recovery). A held
`data/checker.lock` prevents another checker using the same data directory.
Preserve this directory and use only one checker deployment.

Both forms of the targets endpoint return distinct watched subject/term pairs.
Regular rotation continues when there are no watches. Catalog records create
priority work only when a user watches a section.

Failed fetches, malformed snapshots, rejected submissions and rollbacks do not
advance successful database synchronization timestamps. A client timeout remains
ambiguous: Express may finish committing after the client stops waiting.

Express compares section statuses and returns aggregate change counts. Python
logs department summaries. React searches the MariaDB catalog through the
Express course-search API.

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
├── src/               # Scheduled Python checker, HTTP client, and Banner parser
├── database/
│   ├── init/          # Initial database schema
│   └── migrations/    # Additional schema changes
├── data/              # Persistent checker logs and rotation cursor (excluded from Git)
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

   Keep the local defaults `APP_ENV=development`, `APP_ORIGIN=http://localhost:8080`, and `API_SCHEME=http`. Set `CHECKER_TERMS` to one or two term strings, for example `'["202690","202710"]'`; its default `[]` deliberately fails startup until terms are chosen. `BANNER_REQUEST_DELAY` defaults to 5 seconds. `CHECK_INTERVAL` is retired. Never commit `.env`, and keep the session secret stable across restarts. Local HTTP settings are for local use; production requires HTTPS.

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
- Routine commands, term codes, logs, and scheduling are in [Operations](docs/operations.md).
- [Backend](backend/README.md): API endpoints, authentication, and backend configuration.
- [Frontend](frontend/README.md): local React development, lint, and build commands.
