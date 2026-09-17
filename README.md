# NJIT Course Availability Checker

A Python application for monitoring NJIT course availability.

The checker periodically checks configured course sections, tracks their last known availability, and notifies when a section changes from `CLOSED` to `OPEN`.

This project is being developed for IT 610. Local python implementation complete, next step is Docker packaging.

## Project Structure

```text
njit-course-checker/
├── README.md
├── Dockerfile
├── requirements.txt
├── courses.json
├── src/
│   ├── checker.py
│   ├── manual_check.py
│   ├── njit_scraper.py
│   └── output.py
├── data/
│   ├── state.json
│   ├── checker.log
│   └── notification.log
└── docs/
    ├── setup.md
    └── operations.md
```

Runtime files in `data/` are created as needed.

## Current Behavior

The automated checker:

- Runs immediately when started.
- Reloads `courses.json` every cycle.
- Groups configured courses by subject so Banner is only requested once per subject.
- Tracks the last successful status and remaining seats in `data/state.json`.
- Writes activity and errors to `data/checker.log`.
- Writes `CLOSED` to `OPEN` changes to `data/notification.log`.
- Prints detailed course information and notifications to the console.
- Waits `CHECK_INTERVAL` seconds after each cycle. The default is 600 seconds.

The manual checker runs the same course checks once without changing state or writing logs.

## Container Plan

The midterm container will use the existing Python application as its main process.

Planned container behavior:

- Custom Ubuntu base image.
- `America/New_York` timezone.
- `CHECK_INTERVAL=600` by default.
- Persistent `data/` storage.
- Restart policy of `unless-stopped`.
- No cron.
- No Docker health check for the midterm.

## Documentation

- [Setup](docs/setup.md): local setup, configuration, state, logs, and application implementation.
- [Operations](docs/operations.md): Docker container setup, configuration, and usage.
