# NJIT Course Availability Checker

An IT 610 project for checking NJIT course availability. Create an account to
search for sections by term and department, check seat counts and status, and
save sections to your watchlist. Email delivery is planned as a separate worker.
The Watchlist currently shows a disabled notification control.

## How it works

The app runs in four Docker Compose services. The React frontend is served by
Nginx, which forwards API calls to the Express backend. Express handles accounts,
course search, and watchlists using MariaDB. The fourth service is the Python
checker, which fetches department results from NJIT Banner, parses the sections,
and posts a snapshot to Express with a separate API token. Express validates and
saves each snapshot in a transaction.

## Banner department synchronization

The checker rotates through departments at :00 and :30. Every ten minutes
starting at :05, it checks department and term pairs that have at least one
watched section. A watched pair uses the priority schedule while it has watches.
Regular rotation continues when watchlists are empty.

Set `CHECKER_TERMS` to one or two current Banner terms. Compose uses those
same terms for the search dropdown. Search reads saved sections from MariaDB
and never triggers a Banner request.

Only sections that appear in a snapshot get updated. If Banner omits a section,
its last recorded status, last-seen time, and any watches are kept. An empty
snapshot also leaves section records intact. Older availability can go stale,
so check the section's last-seen time. Run one checker deployment at a time to
keep snapshots in order. See [Operations](docs/operations.md#scheduling-and-monitoring).

## Quick start

You need Git, Docker with Compose, and internet access to build the images and
reach Banner.

1. Clone the repo. For a fresh checkout, copy the environment template.

   ```sh
   git clone https://github.com/adrianmdls/njit-course-checker.git
   cd njit-course-checker
   cp .env.example .env
   ```

2. In `.env`, set different values for `DB_ROOT_PASSWORD` and `DB_PASSWORD`.
   Generate separate values for `SESSION_SECRET` and `CHECKER_API_TOKEN` by
   running `openssl rand -hex 32` once for each. Keep `.env` private and keep
   the session secret stable across restarts.

   Set `CHECKER_TERMS` to the terms you want to monitor, for example
   `CHECKER_TERMS='["202690","202710"]'`. See the
   [term code table](docs/operations.md#banner-term-codes). Keep the template's
   HTTP settings for local development. Production requires HTTPS.

3. Build and start the stack.

   ```sh
   docker compose up -d --build --wait
   ```

   Open <http://localhost:8080>, register, and log in. Use `localhost` so the
   browser origin matches `APP_ORIGIN`. Departments appear in search as the
   checker saves data for them.

MariaDB initializes a fresh volume automatically. For an existing volume, back
up the database and [apply only missing migrations](backend/README.md#database-and-migrations).
Keep the MariaDB volume and the checker's `data/` directory. See
[Operations](docs/operations.md) for service commands, logs, and troubleshooting.

## Documentation

- [Backend](backend/README.md) covers the API, database, and configuration.
- [Frontend](frontend/README.md) covers local React development.
- The [Banner smoke-test guide](docs/banner-smoke-test.md) covers disposable integration
  tests and deployment checks.

Earlier implementation notes cover [Banner ingestion](docs/phase-1-sync.md),
[scheduling](docs/phase-2-sync.md), and [persistent watchlists](docs/phase-3-watchlists.md).

Terraform defines the AWS network, private MariaDB instance, and ECS frontend
and backend services. See the [Terraform configuration](infrastructure/terraform/)
and [AWS database initialization and HTTP demo guide](docs/cloud_infrastructure/aws-db-initialization.md).
The broader planned deployment includes the checker and email delivery. See the
[IT 342 architecture diagram](docs/IT%20342%20Architecture%20Diagram.drawio).
