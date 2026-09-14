## Initial Project Structure

The initial project skeleton was created to separate application source code, configuration, persistent runtime data, and documentation.

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
