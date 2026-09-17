# NJIT Course Availability Checker

A Python application for monitoring NJIT course availability.

The application will periodically check configured course sections, display enrollment information, track previous availability state, and notify when a previously closed course becomes open.

This project is being developed for IT 610. Packaging as a single custom Docker container built from an Ubuntu base image is planned.

## Project Structure

```text
njit-course-checker/
├── .gitignore
├── README.md
├── Dockerfile              # Empty placeholder; Docker implementation planned
├── requirements.txt
├── courses.json
├── src/
│   ├── checker.py
│   ├── manual_check.py     # One-time check by configured CRN or label
│   └── njit_scraper.py
├── data/
│   ├── state.json
│   └── checker.log          # Automated checker activity (created at runtime)
└── docs/
    ├── setup.md
    ├── operations.md
    └── troubleshooting.md
```

## Current Status

Banner retrieval and section parsing are implemented. The checker monitors configured CRNs at a configurable interval, saves availability state, logs automated activity to `data/checker.log`, and prints alerts when a section changes from closed to open. Container operation and external notifications are still planned.

## Documentation

- [Setup](docs/setup.md): project structure, local environment, dependencies, and request construction.
- [Operations](docs/operations.md): running retrieval and single-section parsing tests.
- [Troubleshooting](docs/troubleshooting.md): common errors, diagnostics, and fixes.
