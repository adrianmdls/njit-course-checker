# Setup

## Initial Project Structure

```text
njit-course-checker/
├── README.md
├── Dockerfile              # Empty placeholder
├── requirements.txt
├── courses.json
├── src/
│   ├── checker.py          # One-time check and state tracking
│   ├── njit_scraper.py     # Banner retrieval and parsing
│   └── manual_check.py     # Empty placeholder
├── data/
│   └── state.json          # Latest successful results
└── docs/
    ├── setup.md
    ├── operations.md
    └── troubleshooting.md
```

Source code, course configuration, runtime state, and documentation are kept separately. The application does not currently write a log file.

## Local Python Environment

Install Python 3 with `venv` and `pip` support. After cloning the repository, open a terminal in the project root.

Create and activate a virtual environment on macOS or Linux:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

The `.venv` directory is excluded from version control.

## Python Dependencies

Install the versions listed in `requirements.txt`:

```bash
python -m pip install -r requirements.txt
```

The direct dependencies are:

- `requests`: sends HTTP requests to NJIT Banner.
- `beautifulsoup4`: parses section tables in the Banner response.

`base64`, `json`, `pathlib`, and `urllib.parse` are Python standard-library modules and do not belong in `requirements.txt`.

## Banner Data Retrieval

`src/njit_scraper.py` dynamically constructs requests to the NJIT Banner section endpoint:

```text
https://generalssb-prod.ec.njit.edu/BannerExtensibility/internalPb/virtualDomains.stuRegCrseSchedSections
```

The requested subject and term are encoded in the format expected by Banner. The same endpoint can retrieve different subjects, so separate hardcoded department URLs are unnecessary.

The request does not require stored browser cookies or authentication credentials.

Banner returns JSON containing HTML section-table data, which the application parses.

## Section Parsing

The parser extracts:

- CRN
- Section
- Status
- Maximum enrollment
- Current enrollment
- Seats remaining
- Days
- Meeting time
- Location
- Instructor
- Delivery mode

Malformed enrollment data or a missing CRN produces an error rather than silently treating the section as closed.

## Course Configuration

Edit `courses.json` in the project root. CRNs are string keys, and values are human-readable course labels:

```json
{
  "94243": "IT 101-001",
  "94244": "IT 101-003"
}
```

These entries are examples, not project defaults. The repository configuration is currently `{}`, meaning no courses are monitored.

Replace the example entries with the sections you want to check.

Each label must currently begin with its Banner subject, such as `IT` or `CS`, because the checker uses the first word of the label when retrieving section data.

For example:

```json
{
  "94243": "IT 101-001",
  "91500": "CS 100-003"
}
```

The label itself is not checked against the course name returned by Banner.

The term is currently set by the `TERM` constant in `src/checker.py`. The current value is:

```text
202690
```

Configure CRNs that belong to that term.

## Persistent State

`data/state.json` stores the latest successful result for each monitored CRN.

The first successful check establishes a baseline. On later runs, a section changing from `CLOSED` to `OPEN` produces a console notification.

Failed checks do not overwrite the previous successful state.

The checker creates the data directory and state file if needed. The directory must be writable.

Local state persists between runs. Persistent Docker storage for this directory will be configured when container support is implemented.

## Initial Run

With the virtual environment active and courses configured, run the checker from the project root:

```bash
python src/checker.py
```

The checker retrieves the configured sections immediately, prints the results,
saves successful state, and repeats after a wait of 300 seconds by default.
Set `CHECK_INTERVAL` to a positive integer number of seconds to change the wait.
Press `Ctrl+C` to stop.

If `courses.json` is empty, the program prints:

```text
No courses configured in courses.json.
```

See [operations](operations.md) for subsequent usage and [troubleshooting](troubleshooting.md) for common errors.

## Container Setup

Container support is not yet implemented.

The current `Dockerfile` is an empty placeholder, so there is not yet a working image build or container startup process.

Docker build instructions, runtime configuration, and persistent storage setup will be added once the container implementation is complete.
