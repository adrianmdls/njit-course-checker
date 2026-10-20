# NJIT Course Availability Checker

A Dockerized Python application for monitoring NJIT course availability.

The checker periodically checks configured course sections, tracks their last known availability, and notifies users when a section transitions between `CLOSED` and `OPEN`.

This project was developed for IT 610 and runs in a single custom Docker container built from Ubuntu 24.04.

## Project Structure

```
njit-course-checker/
├── README.md
├── Dockerfile
├── compose.yaml
├── .env.example
├── manual_check
├── requirements.txt
├── courses.json
├── src/
│   ├── checker.py
│   ├── discord_notify.py
│   ├── manual_check.py
│   ├── njit_scraper.py
│   └── output.py
├── data/
│   ├── .gitkeep
│   ├── state.json
│   ├── checker.log
│   └── notification.log
└── docs/
    ├── development.md
    └── operations.md
```

Runtime files in `data/` are created as needed and are excluded from Git. The `.env` file is also excluded to prevent exposing webhook URLs.

## Application Behavior

The automated checker:

- Runs immediately when the container starts.
- Reloads `courses.json` every cycle.
- Groups configured courses by subject to minimize Banner requests.
- Tracks the last successful status and remaining seats in `data/state.json`.
- Logs checker activity and errors to `data/checker.log`.
- Logs availability changes (`CLOSED → OPEN` and `OPEN → CLOSED`) to `data/notification.log`.
- Sends optional Discord webhook notifications when course availability changes.
- Prints detailed course information and notifications to the console.
- Waits `CHECK_INTERVAL` seconds between cycles, defaulting to 600 seconds.
- Preserves previous successful state when a check fails.

The manual checker performs a single check without modifying saved state, writing logs, or sending Discord notifications.

## Docker Configuration

The application runs in a single custom Docker container with the following configuration:

- Ubuntu 24.04 base image.
- `America/New_York` timezone.
- Configurable `CHECK_INTERVAL` environment variable.
- Optional `DISCORD_WEBHOOK_URL` environment variable.
- Read-only bind mount for `courses.json`.
- Persistent bind mount for `data/`.
- Docker restart policy of `unless-stopped`.
- No cron or Docker health check.

## Quick Start

1. Clone the repository and navigate to the project directory.

2. Copy the example environment configuration:

   ```bash
   cp .env.example .env
   ```

3. Edit `courses.json` to specify the term and courses to monitor.

4. Optionally configure Discord notifications by adding a webhook URL to `.env`:

   ```dotenv
   CHECK_INTERVAL=600
   DISCORD_WEBHOOK_URL=
   ```

   Leaving `DISCORD_WEBHOOK_URL` empty disables Discord notifications.

5. Build and start the container:

   ```bash
   docker compose up -d --build
   ```

View automated checker output:

```bash
docker compose logs -f
```

Run a manual check:

```bash
docker compose exec checker manual_check
```

Stop and remove the container:

```bash
docker compose down
```

Configuration is managed through `courses.json` and environment variables passed through Docker Compose. Runtime data is preserved in the host's `data/` directory.

## Documentation

- [Development](docs/development.md): Application design, implementation process, and technical decisions.
- [Operations](docs/operations.md): Docker deployment, configuration, and container management.
