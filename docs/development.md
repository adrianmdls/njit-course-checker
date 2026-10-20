# Development

This document gives a short overview of how I built the NJIT Course Availability Checker and the main decisions I made during development.

## Project Structure

```text
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

The source code, course configuration, runtime data, environment settings, and documentation are kept separate.

Runtime files inside `data/` are ignored by Git, with `.gitkeep` used to keep the directory in the repository. The `.env` file is also ignored to prevent sensitive information, such as Discord webhook URLs, from being committed.

## Local Development

I used Python 3 with a virtual environment.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

The main external dependencies are:

- `requests`
- `beautifulsoup4`

The Discord webhook integration uses `requests`, so no additional dependencies are needed.

## Banner Scraper

`src/njit_scraper.py` handles requests to the NJIT Banner course schedule.

The scraper retrieves section information by subject and term. Banner returns JSON containing HTML for the course section tables, which the scraper parses using BeautifulSoup.

It extracts:

- CRN
- Section
- Status
- Enrollment
- Seats remaining
- Days and meeting time
- Location
- Instructor
- Delivery mode
- Credits

Courses with the same subject are grouped together so Banner only needs to be requested once per subject.

## Course Configuration

Courses are configured in `courses.json`.

```json
{
  "term": "202690",
  "courses": {
    "94243": "IT 101-001"
  }
}
```

The application currently supports one term at a time.

Observed NJIT Banner term codes used by the project are:

| Term | Code |
|---|---|
| Spring 2026 | `202610` |
| Summer 2026 | `202650` |
| Fall 2026 | `202690` |
| Winter 2026-2027 | `202695` |

The course label must start with the subject, such as `IT`, `CS`, or `PHIL`.

The automated checker reloads `courses.json` every cycle.

## Automated Checker

`src/checker.py` is the main process.

Each cycle:

1. Reloads `courses.json`.
2. Retrieves course data from Banner.
3. Compares results with the saved state.
4. Logs status changes and sends Discord notifications if enabled.
5. Updates state.
6. Prints the results.
7. Waits before checking again.

The default interval is 600 seconds and can be changed using the `CHECK_INTERVAL` environment variable.

The first successful check creates the baseline.

After that, the checker detects:

- `CLOSED → OPEN`
- `OPEN → CLOSED`

Failed course checks do not overwrite the previous successful state.

## Environment Variables

Runtime configuration is handled using environment variables passed through Docker Compose.

The `.env.example` file provides the default configuration:

```dotenv
CHECK_INTERVAL=600
DISCORD_WEBHOOK_URL=
```

- `CHECK_INTERVAL` determines the time between automated checks in seconds.
- `DISCORD_WEBHOOK_URL` optionally enables Discord notifications.

The actual `.env` file is excluded from Git to avoid exposing webhook URLs.

## Discord Webhook Notifications

`src/discord_notify.py` handles sending notifications to Discord.

When a course changes from `CLOSED → OPEN` or `OPEN → CLOSED`, the checker records the event in `notification.log` and calls `send_discord_notification()`.

The function uses `requests.post()` to send the notification to the configured Discord webhook URL.

Discord notifications are optional. If `DISCORD_WEBHOOK_URL` is empty or not defined, the function skips sending the notification.

A request timeout and exception handling prevent Discord connection failures from stopping the checker.

I kept the Discord notification logic in a separate module to avoid adding unnecessary complexity to `checker.py` and to make it easier to reuse in the final multi-container version.

## State and Logs

Runtime files are stored in `data/`.

- `state.json` stores the latest successful course state.
- `checker.log` stores automated checker activity and errors.
- `notification.log` stores course status changes.

Discord notifications are separate from local logging. Status changes are still recorded in `notification.log` even if Discord is disabled or the webhook request fails.

If the configured term changes, state from the previous term is not used for availability comparisons. The new term's state is saved after a successful course check.

## Manual Checker

`src/manual_check.py` performs one course check without changing state, writing logs, or sending Discord notifications.

Inside the container it can be run with:

```bash
docker compose exec checker manual_check
```

The command assumes the Docker Compose service is named `checker`.

## Docker

The application runs in one custom Docker container based on Ubuntu 24.04.

The container:

- Runs the checker as its main process.
- Uses a continuous `while` loop with `time.sleep()` between checks instead of cron.
- Uses the `America/New_York` timezone.
- Uses `unless-stopped` as the restart policy.
- Mounts `courses.json` as read-only.
- Mounts `data/` for persistent state and logs.
- Receives environment variables through Docker Compose.

Docker Compose is used to define and run the single-container deployment in one configuration file.

For container commands and usage, see [Operations](operations.md).
