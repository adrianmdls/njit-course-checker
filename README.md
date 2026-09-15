# NJIT Course Availability Checker

A containerized Python application for monitoring NJIT course availability.

The application will periodically check configured course sections, display enrollment information, track previous availability state, and notify when a previously closed course becomes open.

This project is being developed for IT 610 and is packaged as a single custom Docker container built from an Ubuntu base image.

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
│   └── njit_scraper.py
├── data/
│   ├── state.json
│   └── checker.log
└── docs/
    ├── setup.md
    ├── operations.md
    └── troubleshooting.md
```

## Current Status

The Python retrieval foundation is implemented and has been verified with IT and CS data from NJIT Banner. Container operation, section parsing, scheduling, persistent state, and notifications are still planned.

## Documentation

- [Setup](docs/setup.md): project structure, local environment, dependencies, and request construction.
- [Operations](docs/operations.md): running the current retrieval test.
- [Troubleshooting](docs/troubleshooting.md): common errors, diagnostics, and fixes.
