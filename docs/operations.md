## Current Operation

Run continuous monitoring from the project root:

```bash
CHECK_INTERVAL=300 .venv/bin/python src/checker.py
```

The checker runs immediately, then waits `CHECK_INTERVAL` seconds after each
check finishes. The default is 300 seconds; the value must be a positive integer.
Press `Ctrl+C` to stop. Course configuration is reloaded each cycle. Retrieval
failures preserve previous state and are retried on the next cycle. Successful
results are saved in `data/state.json`, with console alerts for `CLOSED` to `OPEN`
changes within the same term.

## Retrieval Test

The current application supports a local Banner retrieval test. Run these commands from the project root after completing the setup instructions in [setup.md](setup.md):

```bash
source .venv/bin/activate
python src/njit_scraper.py
```

The script performs one request for IT sections in term `202690`, prints a response preview, and exits. The output goes only to the console.

## Checking Another Subject

To test CS using the shared retrieval function without changing the script, run from the project root:

```bash
python -c 'from src.njit_scraper import get_sections; sections = get_sections("CS", "202690"); print("JSON type:", type(sections).__name__); print("Response preview:", str(sections)[:2000])'
```

Check that the response is a list and the preview contains CS courses. An empty list does not establish that the requested subject and term contain section data.

## Manual Course Lookup

With the virtual environment active, run from the project root:

```bash
python src/manual_check.py CS 288 005
```

Supply a subject, course number, and section. Lowercase input is uppercased;
numeric sections are padded to three digits (`cs 288 5` becomes `CS 288-005`).
The script uses `TERM` from `src/checker.py`, fetches only the requested subject,
and finds the CRN from Banner. It prints a local timestamp, enrollment, seats
remaining, and Banner status, then exits. The seat-available indicator requires
both an OPEN status and a positive seat count.

This lookup does not read `courses.json`, write state or logs, send notifications,
or start the monitoring loop. Exit codes are 0 for a found section (open or closed),
1 for a missing section or lookup failure, and 2 for invalid command-line arguments.

## Checking One Section by CRN

After installing the updated dependencies from `requirements.txt`, run from the project root with the virtual environment active:

```bash
python - <<'PY'
from pprint import pprint
from src.njit_scraper import get_sections, parse_section

sections = get_sections("IT", "202690")
section = parse_section(sections, "94243")
pprint(section)
PY
```

The result shows the matching section's meeting details, instructor, enrollment, seats remaining, and status. Change the subject, term, and CRN together to inspect another section. This development test prints only to the console and does not read course configuration or write state or logs.

## Planned Container Operation

Container support, persistent file logging, and external notifications are not
implemented yet. Container build, startup,
restart, and maintenance commands will be added when those features are available.
