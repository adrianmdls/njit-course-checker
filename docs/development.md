# Development

This document gives a short overview of how I built the NJIT Course Availability Checker and the main decisions I made during development.

## Project Structure

```text
njit-course-checker/
├── README.md
├── Dockerfile
├── compose.yaml
├── manual_check
├── requirements.txt
├── courses.json
├── src/
│   ├── checker.py
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

The source code, course configuration, runtime data, and documentation are kept separate.

Runtime files inside `data/` are ignored by Git, with `.gitkeep` used to keep the directory in the repository.

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
4. Logs status changes.
5. Updates state.
6. Prints the results.
7. Waits before checking again.

The default interval is 600 seconds and can be changed using `CHECK_INTERVAL`.

The first successful check creates the baseline.

After that, the checker detects:

- `CLOSED -> OPEN`
- `OPEN -> CLOSED`

Failed checks do not overwrite the previous successful state.

## State and Logs

Runtime files are stored in `data/`.

- `state.json` stores the latest successful course state.
- `checker.log` stores automated checker activity and errors.
- `notification.log` stores course status changes.

If the configured term changes, the saved state is reset.

## Manual Checker

`src/manual_check.py` performs one course check without changing state or writing logs.

Inside the container it can be run with:

```bash
docker compose exec njit-course-checker manual_check
```

## Docker

The application runs in one custom Docker container based on Ubuntu 24.04.

The container:

- Runs the checker as its main process.
- Uses a continuous `while` loop with `time.sleep()` between checks instead of cron.
- Uses the `America/New_York` timezone.
- Uses `unless-stopped` as the restart policy.
- Mounts `courses.json` as read-only.
- Mounts `data/` for persistent state and logs.

Docker Compose is used to define and run the single-container deployment in one configuration file.

For container commands and usage, see [Operations](operations.md).
