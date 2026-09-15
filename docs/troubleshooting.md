## Missing Python Dependencies

If the script reports `ModuleNotFoundError: No module named 'requests'`, the virtual environment may not be active or its dependencies may not be installed.

From the project root, run:

```bash
source .venv/bin/activate
python -m pip install -r requirements.txt
python src/njit_scraper.py
```

If `.venv/bin/activate` is missing, create the virtual environment using the instructions in [setup.md](setup.md).

## Connection Errors and Timeouts

A connection error can indicate a DNS problem, restricted network access, or an unavailable NJIT service. A timeout means the request exceeded a configured timeout while connecting or waiting for data.

Check the traceback, confirm network access, and try opening the NJIT schedule page in a browser:

```text
https://generalssb-prod.ec.njit.edu/BannerExtensibility/customPage/page/stuRegCrseSched
```

Retry the script after connectivity is restored. The current test makes one request and does not retry automatically.

## HTTP Errors

The script raises an HTTP error for unsuccessful HTTP responses. Check the status code in the traceback and whether the NJIT schedule page is available. If the page works but the script repeatedly fails, the Banner request format or access requirements may have changed.

Do not copy browser cookies or session IDs into source code to work around an error.

## Unexpected Response Data

A JSON decoding error means the response could not be parsed as JSON. The server may have returned an HTML error or access page, even if the HTTP status was successful.

For diagnosis, temporarily print the response status, content type, and a short response-body preview before `response.json()` in `get_sections()`. Avoid printing cookies or session values.

HTML inside the `SECTIONS_TABLE` field is expected: Banner returns a JSON list containing HTML tables. Individual section parsing will be implemented separately.

If the result is empty or contains unexpected courses, check the subject and term passed to `get_sections()`. IT and CS have been verified with term `202690`; other terms have not yet been verified.
