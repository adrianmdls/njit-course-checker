# NJIT Course Availability Checker

An IT 610 project under development using Docker Compose to run a React/Nginx frontend, an Express backend, a MariaDB database, and a Python course availability checker.

The frontend sends `/api/` requests through Nginx to Express, which connects to MariaDB. The Python checker also reads and updates MariaDB. Docker networking connects the services internally.

## Current Functionality

- Account registration, login/logout, and session-based access to the dashboard.
- Express database health endpoint and authentication API.
- Python monitoring of database-configured sections, availability updates, local logs, and optional Discord notifications.

The dashboard currently displays mock course data. Course search and watchlist management are not yet connected to the Express API. An empty database has no sections to monitor.

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

2. Edit `.env` and set distinct `DB_ROOT_PASSWORD` and `DB_PASSWORD` values, plus `SESSION_SECRET`. Generate a secret with `openssl rand -hex 32` (requires OpenSSL), then paste the result into `.env`.

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
