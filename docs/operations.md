## Current Operation

Run continuous monitoring from the project root:

```bash
.venv/bin/python src/checker.py
```

The checker runs immediately, then waits `CHECK_INTERVAL` seconds after each
check finishes. The default is 600 seconds (10 minutes); the value must be a positive integer.
For a shorter test interval, run `CHECK_INTERVAL=10 .venv/bin/python src/checker.py`.
Press `Ctrl+C` to stop. Course configuration is reloaded each cycle. Retrieval
failures preserve previous state and are retried on the next cycle. Successful
results are saved in `data/state.json`, with console alerts for `CLOSED` to `OPEN`
changes within the same term.

Each cycle prints one summary before the course results: its start time,
success or error count, and estimated next run time (completion time plus the
configured interval). Successful checks show instructor, meeting details,
delivery mode, credits, enrollment, seats remaining, and status.

Each failed course counts as one error, including every affected course when
a subject request fails. Failure details follow the summary; previous valid
state is preserved. Configuration or state-file failures are also reported.
Only a stored `CLOSED` status changing to `OPEN` prints `[NOTIFICATION]` with
the course, CRN, and remaining seats. A first-time `OPEN` result sets a baseline.
Console output is also accompanied by persistent operational logging in
`data/checker.log`. Each cycle logs its start, each course's label, CRN, status,
and seats remaining on success, and whether the cycle completed successfully
or with errors. Errors identify the affected course or operation at ERROR level.
Entries include timestamps and are appended across runs. The checker creates
`data/` if needed. `state.json` stores the last successful availability state
for transition detection; `checker.log` records operational history.
Docker and external notifications are not implemented.

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

## Manual Course Check

Check every course configured in `courses.json` once:

```bash
python src/manual_check.py
```

No command-line arguments are needed. The script reads the same term and courses
as the automated checker and uses the same summary, detailed course output, and
error formatting. The summary shows `Next Run: N/A (manual check)`.
It exits after one check, returning a nonzero exit code if any errors occurred.
Manual checks do not read or write `state.json`, generate change notifications,
or write to `checker.log`.

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

Container support and external notifications are not
implemented yet. Container build, startup,
restart, and maintenance commands will be added when those features are available.
