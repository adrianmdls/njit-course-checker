# Banner pipeline verification

Run from the repository root. Automated tests use deterministic Banner HTML
fixtures; only the upstream fetch is replaced. Python HTTP requests, the actual
Express server, authentication, transactions, and MariaDB are real.

## Disposable automated verification

Requires Docker Compose v2 and host Python 3. No host Python packages are needed.

```sh
python3 -B tests/integration/test_pipeline.py
```

The runner builds the existing application Dockerfiles, creates a randomly named
test project, and removes it on completion. MariaDB data lives in tmpfs. No host
ports, application `.env`, production volumes, or production records are used.
The checker has no DB credentials and shares no network with MariaDB; tests also
block Python database imports and check that the database IP is unreachable.
SQL setup and observations run through the disposable backend container.
Built test images remain cached for reruns and the focused commands below.

Eight integration tests cover configured and watched targets, deduplication,
full snapshot polling, actual client GET/POST authentication, stable IDs and
Watchlists, repeat requests, real status transitions, late transaction failure,
failed Banner fetches, manual read-only behavior, and application Compose wiring.
Failure tests compare all course, section, Watchlist, and synchronization rows;
timestamps are deliberately aged so accidental freshness updates cannot hide
within the same second. Fixtures include Winter terms, alphanumeric section
labels, and titles containing ` - `.

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

## Optional local Compose smoke test with live Banner

Use a local development database. Live polling updates the chosen real targets;
do not submit the automated test's fabricated snapshots to an application DB.
Live Banner may return errors independently of this pipeline.

1. Copy `.env.example` to `.env` only if `.env` does not already exist. Set distinct
   database passwords, `SESSION_SECRET`, and `CHECKER_API_TOKEN`. Keep
   `APP_ENV=development`, `API_SCHEME=http`, and
   `CHECKER_API_URL=http://backend:3000` locally. Set a current real department/term
   in `CHECKER_MONITORING_TARGETS`, or use existing Watchlists. The examples below
   retrieve the configured targets rather than hard-coding a current term.
2. Stop the background checker while running one-shot checks:

   ```sh
   docker compose config --quiet
   docker compose stop checker
   docker compose up -d --build --wait db backend
   docker compose build checker
   ```

3. Check database health and authenticated target retrieval from the checker:

   ```sh
   docker compose run --rm --no-deps checker python -B -c \
     'import os,requests; r=requests.get(os.environ["CHECKER_API_URL"]+"/api/health",timeout=10); r.raise_for_status(); print(r.json())'
   docker compose run --rm --no-deps checker python -B -c \
     'from src.checker_api import get_monitoring_targets; print(get_monitoring_targets())'
   ```

   Expect a connected database and the desired unique target pairs. An empty
   target list is a valid idle configuration; it does not verify a Banner fetch.

4. Run the actual manual checker, which reads Banner without submitting updates:

   ```sh
   docker compose run --rm --no-deps checker python -B -m src.manual_check
   ```

5. Optionally perform one real synchronization cycle:

   ```sh
   docker compose run --rm --no-deps checker python -B -c \
     'from src.checker import check_once; rows,errors,term=check_once(); print("\n".join(rows)); raise SystemExit(1 if errors else 0)'
   ```

   Expect one department summary per target. If Banner fails, the command exits
   nonzero; do not interpret that as successful synchronization. Identical
   fixture retries are tested automatically; two separate live fetches can
   legitimately report changes.

6. Inspect stored synchronization timestamps and sample records through Express's
   database connection, without printing credentials:

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

   Run this inspection before and after step 4 if checking manual behavior by
   hand. The automated test makes the stronger full-row equality assertion.

7. Once satisfied, run exactly one background checker:

   ```sh
   docker compose up -d checker
   docker compose logs --tail=30 checker backend
   ```

   Do not run one-shot synchronization alongside the background checker.

## Future VMware smoke test

Application-level integration is verified by the disposable suite. VMware DNS,
routing, TLS termination, and firewall rules must still be checked in the actual
deployment; they are not configured by this commit.

On the backend VM, provide the normal database variables, `SESSION_SECRET`, a
shared `CHECKER_API_TOKEN`, and explicit targets as needed. Use
`APP_ENV=production`, the exact HTTPS `APP_ORIGIN`, and a trusted TLS proxy.
For the current Nginx configuration, `API_SCHEME=https` is appropriate only
behind real TLS termination; that setting does not encrypt HTTP by itself.
Keep direct backend and database ports unreachable from the checker VM.

On the checker VM, create a private `checker.env` containing only:

```dotenv
CHECKER_API_URL=https://your-backend.example.edu
CHECKER_API_TOKEN=<same secret as the backend>
CHECK_INTERVAL=600
TZ=America/New_York
```

Do not commit that file, enable shell tracing, or print its contents. No `DB_*`
variables are required. Build the existing checker Dockerfile from this checkout
(or transfer the same tested image). Run these commands while the automated
checker is stopped:

```sh
chmod 600 checker.env
docker build -t njit-checker:banner-integration .
docker run --rm --env-file checker.env njit-checker:banner-integration python -B -c \
  'import os,requests; r=requests.get(os.environ["CHECKER_API_URL"]+"/api/health",timeout=10); r.raise_for_status(); print(r.json())'
docker run --rm --env-file checker.env njit-checker:banner-integration python -B -c \
  'from src.checker_api import get_monitoring_targets; print(get_monitoring_targets())'
docker run --rm --env-file checker.env njit-checker:banner-integration python -B -m src.manual_check
```

Then optionally run the one-shot synchronization command from step 5 using
`docker run --rm --env-file checker.env njit-checker:banner-integration` in place
of `docker compose run --rm --no-deps checker`. Inspect timestamps on the backend
VM using step 6. Start exactly one managed checker only after those checks pass.

Certificate validation must succeed; do not disable it to make the test pass.
For a private CA, install its trust chain or supply the existing Requests
`REQUESTS_CA_BUNDLE` setting with a mounted CA file. Confirm the checker can
reach HTTPS and public Banner while it cannot reach MariaDB. Configure explicit
legacy monitoring targets deliberately; NULL course links do not preserve
monitoring intent.

Known limits remain: no notifications, no snapshot ordering protection for
multiple producers, and ambiguous completion after an HTTP timeout. The
standalone legacy search helper still has SQL cache reads and must not run on
the checker VM without a separate migration. A full department body may also
hit a proxy body limit before Express; the test stack directly exercises
Express, so check the deployed proxy with representative real snapshots.
