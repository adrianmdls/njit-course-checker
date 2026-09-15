## Current Operation

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

## Planned Container Operation

Scheduled checks, `CHECK_INTERVAL`, `courses.json` loading, persistent state and logging, notifications, and the `manual-check` command are not implemented yet. Container build, startup, restart, and maintenance commands will be added when those features are available.
