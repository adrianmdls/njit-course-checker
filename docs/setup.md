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
- `beautifulsoup4` extracts section details from the HTML tables using Python's built-in `html.parser`.
- `soupsieve` and `typing_extensions` are dependencies used by `beautifulsoup4`.
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

Both IT and CS retrieval were verified for term `202690`. Other terms have not yet been verified.

Importing the module does not make a request or print output. The preview runs only when the file is executed directly.

## Section Parsing

`parse_section(sections, crn)` reads the HTML in each `SECTIONS_TABLE` field and returns the first section row whose CRN matches the requested value. Pass the JSON returned by `get_sections()` as `sections`. Parsing does not make an additional network request.

The returned dictionary includes CRN, section, days, meeting time, location, instructor, delivery mode, credits, information, and comments. Enrollment values are integers. `seats_remaining` is maximum enrollment minus current enrollment; an over-capacity section can therefore have a negative value. `status` is Banner's reported status converted to `OPEN` or `CLOSED`.

The parser uses the verified 13-column table layout. It raises `ValueError` if the CRN is missing, a matching row has an unexpected column count, enrollment cannot be converted to integers, or the reported status is unrecognized. These errors are not converted into a closed or zero-seat result.

CRN `94243` was checked against the live IT table for term `202690`. At verification, the section was open with 28 students enrolled out of 35 and 7 seats remaining. Enrollment can change after this check.

The parser returns the first matching row only; it does not combine separate meeting rows. It does not read `courses.json` or validate course names against CRNs. The configured course name will be used when configuration loading is implemented.

Beautiful Soup usage follows the [official documentation](https://www.crummy.com/software/BeautifulSoup/bs4/doc/).

## Container Setup Status

Container construction and startup are not implemented yet. Docker dependencies, source installation, read-only course configuration, persistent storage, timezone, interval configuration, and restart policy will be documented here as they are implemented.
