# Banner pipeline verification

Run from the repository root. Automated tests use deterministic Banner HTML
fixtures; only the upstream fetch is replaced. Python HTTP requests, the actual
Express server, authentication, transactions, and MariaDB are real.

## Disposable automated verification

Requires Docker Compose v2 and host Python 3. No host Python packages are needed.

```sh
python3 -B tests/integration/test_pipeline.py
# Also exercise the actual React build through Nginx using local Chrome:
RUN_BROWSER_TESTS=1 python3 -B tests/integration/test_pipeline.py
```

The runner builds the existing application Dockerfiles, creates a randomly named
test project, and removes it on completion. MariaDB data lives in tmpfs. No host
database/backend ports, application `.env`, production volumes, or production records are used.
The frontend publishes one temporary loopback port; the runner selects it and
sets the matching test-only `APP_ORIGIN`. Nginx forwards real `/api/` requests.
The checker has no DB credentials and shares no network with MariaDB; tests also
block Python database imports and check that the database IP is unreachable.
SQL setup and observations run through the disposable backend container.
Built test images remain cached for reruns and the focused commands below.

The pipeline covers watchlist priority and regular rotation, target deduplication
and removal, scheduled snapshot submission, actual client GET/POST authentication,
stable IDs and Watchlists, retries, status transitions, late transaction failure,
failed Banner fetches, read-only target and catalog requests, and Compose wiring.
The existing production-authentication smoke script also runs inside the test
backend, checking HTTPS requirements and secure cookie flags in a child process.
Failure tests compare all course, section, Watchlist, and synchronization rows;
timestamps are deliberately aged so accidental freshness updates cannot hide
within the same second. Fixtures include Winter terms, alphanumeric section
labels, and titles containing ` - `.

Course-search coverage adds real cookie login, unauthenticated `401`, mandatory subject,
number-prefix/full-code and stored status filters, sorting, pagination totals,
repeat synchronization, updated enrollment/status, and empty unsynchronized
department/term results. Full-row snapshots prove searches leave course,
section, Watchlist and sync records unchanged. Internal Docker networks prevent
searches from reaching live Banner. The 53-section fixture exercises two pages.
An additional catalog-options test covers empty catalogs, deduplicated local
term/subject pairs (including ECE and Winter), exclusion of unlinked sections
and unscheduled courses, authentication and read-only behavior.

`RUN_BROWSER_TESTS=1` requires host Node >=24 and Chrome/Chromium. Set `CHROME_BIN`
to its executable on systems other than macOS. The dependency-free Chrome
DevTools helper does **not** mock fetch: it logs in via React, inspects actual
search parameters, renders synchronized records and statuses, tests pagination,
persistent Add/reload/Remove, duplicate clicks, retryable watchlist failures,
empty results, and expires the actual MariaDB session to verify redirection.
Watchlist changes in the browser test are removed before its final snapshot
comparison; existing fixture users' watches remain untouched.
One synchronized row is explicitly changed to NULL capacity/enrollment to test
legacy nullable values, which the normalized ingestion contract cannot supply.
Browser checks also capture a Spring 2027 department search, HTTP status and
pagination metadata, exercise metadata network failure/retry and expiry, and
verify required department selection, term-dependent departments and submitted
pagination filters. They register a fresh account, log in and out through React,
and check the protected route after logout. A fixture-only activity toggle on the
disposable database verifies Unavailable/last-seen watchlist rendering and search
exclusion, then restores activity. Transactional activity changes are covered by
the separate API lifecycle and migration tests.
The empty-catalog browser case verifies the explanatory message and disabled search.
The pipeline tests run with or without the browser flag. Browser failures
fail the suite when requested. Cleanup removes its
temporary Chrome profile as well as the Compose stack, including on test failure.

After the integration runner builds the test images, run the focused suites
separately without application credentials:

```sh
docker run --rm -v "$PWD:/workspace:ro" -w /workspace \
  -e PYTHONDONTWRITEBYTECODE=1 njit-banner-integration-checker \
  python -B -m unittest discover -s tests -v
docker run --rm -v "$PWD/backend/test:/app/test:ro" njit-banner-integration-backend npm test
```

The first command above runs Python tests with mocked network/database calls;
it does not start a polling loop. The backend command runs HTTP/authentication
tests; its database group is intentionally skipped without `TEST_DB_PORT`.
The disposable full-pipeline suite is the repeatable cross-language database
verification. The existing backend database suite can also be run against a
fresh disposable database as described in [backend documentation](../backend/README.md#tests).

## Disposable frontend smoke test

For interactive checks, use this separate stack, never the application database:

```sh
export INTEGRATION_HTTP_PORT=8089 # choose an unused localhost port
docker compose --env-file /dev/null -p njit-search-smoke -f tests/integration/compose.yaml build backend frontend checker-test
docker compose --env-file /dev/null -p njit-search-smoke -f tests/integration/compose.yaml up -d --wait frontend
printf '%s' '{"mode":"submit","subject":"CS","term":"202710","section_count":53,"mixed":true}' | \
  docker compose --env-file /dev/null -p njit-search-smoke -f tests/integration/compose.yaml run --rm --no-deps -T checker-test
```

Open `http://127.0.0.1:8089`, register a test account and log in. In Search Courses,
select Spring 2027, department CS and `CS 100` (or prefix `1`). Expect 53 matches,
50 on page 1 and three on page 2. Test each status, sort/order, Previous/Next and
Add. Only locally available terms/departments appear. Search stays disabled until
a department is selected. Changing terms clears an unavailable selection; changing
either term or department clears old results. A nonexistent course
prefix such as `99999` returns an empty list; direct authenticated API requests
for PHIL or Fall 2026 also return empty results for this fixture. Searches and
catalog options never trigger Banner or synchronization. In browser developer tools, confirm requests use
`/api/courses`, `term=202710`, `subject=CS`, `query`, `status`, `sort`, `order`,
`limit=50`, `offset`, and the session cookie. An unauthenticated request returns
`401`; the authenticated API is also inspectable directly in those tools.

To check nullable values and expiration, run the following **only** on this stack,
then search again (after the first command expect em dashes; after the second
expect the login page):

```sh
docker compose --env-file /dev/null -p njit-search-smoke -f tests/integration/compose.yaml exec -T backend node -e "const p=require('./src/db');p.query('UPDATE Sections SET capacity=NULL,enrolled=NULL WHERE crn=12000').finally(()=>p.end())"
docker compose --env-file /dev/null -p njit-search-smoke -f tests/integration/compose.yaml exec -T backend node -e "const p=require('./src/db');p.query('UPDATE sessions SET expires=1').finally(()=>p.end())"
docker compose --env-file /dev/null -p njit-search-smoke -f tests/integration/compose.yaml down --volumes --remove-orphans
unset INTEGRATION_HTTP_PORT
```

## Optional local Compose smoke test with live Banner

Use a local development database. Live polling updates the chosen real targets;
do not submit the automated test's fabricated snapshots to an application DB.
Live Banner may return errors independently of this pipeline.

1. Copy `.env.example` to `.env` only if `.env` does not already exist. Set distinct
   database passwords, `SESSION_SECRET`, and `CHECKER_API_TOKEN`. Keep
   `APP_ENV=development`, `API_SCHEME=http`, and
   `CHECKER_API_URL=http://backend:3000` locally. Set `CHECKER_TERMS` to the real
   terms for regular rotation. Create a Watchlist entry to verify priority work.
2. Validate the configuration and start the local stack with one checker.

   ```sh
   docker compose config --quiet
   docker compose up -d --build --wait
   ```

3. Check database health and authenticated target retrieval from the checker.

   ```sh
   docker compose exec -T checker python -B -c \
     'import os,requests; r=requests.get(os.environ["CHECKER_API_URL"]+"/api/health",timeout=10); r.raise_for_status(); print(r.json())'
   docker compose exec -T checker python -B -c \
     'from src.checker_api import get_monitoring_targets; print(get_monitoring_targets())'
   ```

   Expect a connected database and distinct watched pairs. An empty target list
   means no priority work is scheduled. Regular rotation continues.

4. After a scheduled slot, check `data/checker.log` and inspect stored
   synchronization timestamps and sample records through Express's database connection.

   ```sh
   docker compose exec -T backend node <<'JS'
   const pool = require('./src/db');
   (async () => {
     const [syncs] = await pool.execute('SELECT subject,term,last_synced_at FROM DepartmentSyncs ORDER BY subject,term');
     const [sections] = await pool.execute('SELECT s.id,s.subject,s.term,s.crn,s.status,c.title FROM Sections s LEFT JOIN Courses c ON c.id=s.course_id ORDER BY s.id LIMIT 10');
     console.log({ syncs, sections });
   })().catch(error => { console.error(error.code || 'Database check failed'); process.exitCode = 1; })
     .finally(() => pool.end());
   JS
   ```

## Future VMware smoke test

Application-level integration is verified by the disposable suite. VMware DNS,
routing, TLS termination, and firewall rules must still be checked in the actual
deployment; they are not configured by this commit.

On the backend VM, provide the normal database variables, `SESSION_SECRET`, a
shared `CHECKER_API_TOKEN`. Use
`APP_ENV=production`, the exact HTTPS `APP_ORIGIN`, and a trusted TLS proxy.
For the current Nginx configuration, `API_SCHEME=https` is appropriate only
behind real TLS termination; that setting does not encrypt HTTP by itself.
Keep direct backend and database ports unreachable from the checker VM.

On the checker VM, create a private `checker.env` containing only:

```dotenv
CHECKER_API_URL=https://your-backend.example.edu
CHECKER_API_TOKEN=<same secret as the backend>
CHECKER_TERMS=["202690","202710"]
BANNER_REQUEST_DELAY=5
TZ=America/New_York
```

Do not commit that file, enable shell tracing, or print its contents. No `DB_*`
variables are required. Build the existing checker Dockerfile from this checkout
(or transfer the same tested image). Check the backend connection and target
list before starting the scheduled checker.

```sh
chmod 600 checker.env
docker build -t njit-checker:banner-integration .
docker run --rm --env-file checker.env njit-checker:banner-integration python -B -c \
  'import os,requests; r=requests.get(os.environ["CHECKER_API_URL"]+"/api/health",timeout=10); r.raise_for_status(); print(r.json())'
docker run --rm --env-file checker.env njit-checker:banner-integration python -B -c \
  'from src.checker_api import get_monitoring_targets; print(get_monitoring_targets())'
```

Start one managed checker after those checks pass. After a scheduled slot,
inspect timestamps on the backend VM using the query in the local procedure above.

Certificate validation must succeed; do not disable it to make the test pass.
For a private CA, install its trust chain or supply the existing Requests
`REQUESTS_CA_BUNDLE` setting with a mounted CA file. Confirm the checker can
reach HTTPS and public Banner while it cannot reach MariaDB. Watches determine
priority work. The configured terms and department list determine regular rotation.

Known limits remain: no notifications, no snapshot ordering protection for
multiple producers, and ambiguous completion after an HTTP timeout. A full
department body may hit a proxy body limit before Express; fixture ingestion
bypasses Nginx even though search/browser tests use it, so check the deployed
proxy with representative real snapshots.
