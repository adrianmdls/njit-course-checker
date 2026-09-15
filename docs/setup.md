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
```

The current implementation retrieves course section data from NJIT Banner. The Dockerfile, scheduled checker, manual checker, and persistent data handling are still placeholders.

## Local Python Environment

A Python virtual environment is used for local development so project dependencies remain isolated from the system-wide Python installation.

From the project root, create the virtual environment:

```bash
python3 -m venv .venv
source .venv/bin/activate
```

Install the project dependencies:

```bash
python -m pip install -r requirements.txt
```

The virtual environment is local to this repository and is excluded from version control by `.gitignore`. Python cache files are also excluded.

## Python Dependencies

`requirements.txt` records the installed package versions so the local environment can be recreated.

- `requests` sends HTTP requests to NJIT Banner.
- `certifi`, `charset-normalizer`, `idna`, and `urllib3` are dependencies used by `requests`.
- `base64` and `urllib.parse` are included in the Python standard library and do not require installation.

## Banner Request Construction

`src/njit_scraper.py` provides `get_sections(subject, term)` to retrieve section data from the following endpoint:

```text
https://generalssb-prod.ec.njit.edu/BannerExtensibility/internalPb/virtualDomains.stuRegCrseSchedSections
```

The subject and term are Base64 encoded and then URL encoded. The numeric prefixes and remaining parameters are preserved from the verified Banner request because their full meaning has not been established. No copied browser cookies or session credentials are included.

The request uses a 30-second timeout and checks for HTTP errors before decoding the response as JSON. Retrieval and JSON decoding errors propagate to the caller.

## Retrieval Verification

From the project root, with the virtual environment active, run:

```bash
python src/njit_scraper.py
```

The script requests IT sections for term `202690` and prints the JSON type and the first 2,000 characters of the response representation. Successful verification returned a JSON list containing HTML section tables in `SECTIONS_TABLE`. The table includes section, CRN, meeting details, status, maximum enrollment, current enrollment, instructor, and other section information.

Both IT and CS retrieval were verified for term `202690`. Other terms have not yet been verified. Individual section parsing is not implemented yet.

Importing the module does not make a request or print output. The preview runs only when the file is executed directly.

## Container Setup Status

Container construction and startup are not implemented yet. Docker dependencies, source installation, read-only course configuration, persistent storage, timezone, interval configuration, and restart policy will be documented here as they are implemented.
