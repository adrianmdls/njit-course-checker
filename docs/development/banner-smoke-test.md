# Banner pipeline verification

Run these checks from the repository root. The disposable pipeline uses saved
Banner HTML fixtures in place of live Banner requests. It runs the Python
parser and scheduler path, Express, Nginx, and MariaDB.

## Disposable automated verification

Install Docker with Compose and use a host Python 3 interpreter. The runner
uses the Python standard library. Docker needs network access to pull base
images and install dependencies during the build.

```sh
python3 -B tests/integration/test_pipeline.py
```

Each run builds the app images and starts its own randomly named Compose
project with a test database, test-only credentials, and a temporary frontend
port on loopback. The database uses tmpfs. Express and MariaDB have no published
ports. The runner ignores the application's `.env` and uses no application
volumes. The fixture checker has no database credentials or direct database
network access. The runner removes its stack and volumes even on test failure.
Built images stay cached.

The pipeline checks:

- Scheduled fixture ingestion, regular rotation with no watches, and priority
  checks as watches are added or removed.
- Stable section IDs and watches, status changes, empty or partial snapshot
  preservation, rejected input, and transaction rollback.
- Direct and Nginx-proxied ingestion, including acceptance at exactly 5 MiB,
  rejection above it, and unchanged Nginx and Express limits on the login route.
- Session-authenticated search, term and department options, filters, sorting,
  pagination, and watchlist reads through Nginx.
- Existing-volume migration cases on a disposable schema, session restoration
  and expiration, production HTTPS and cookie behavior, and Compose wiring.

## Optional Chrome tests

Install Node.js 24 or newer and Chrome or Chromium on the host. The runner
defaults to the macOS Google Chrome install path. Set `CHROME_BIN` to the
browser executable if it lives elsewhere. Use a Docker Compose version that
supports the `!reset` override tag.

```sh
RUN_BROWSER_TESTS=1 python3 -B tests/integration/test_pipeline.py
```

Chrome drives the built React app through Nginx. The populated and empty
catalog tests cover department selection, search, pagination, watchlist
add/remove and reload, error recovery, and session expiry. The authentication
lifecycle in [auth_browser.mjs](../../tests/integration/auth_browser.mjs) checks
registration, login, logout, session persistence across a backend restart,
and recovery with the same session after MariaDB stops and starts. During the
outage it checks for `503` from both `/api/auth/me` and `/api/health`. It also
checks the login and registration rate limits on the disposable backend.

The browser run adds [auth-compose.yaml](../../tests/integration/auth-compose.yaml).
The override uses `!reset` to remove MariaDB's container-local tmpfs mount,
which would lose its data on stop/start. A test-only tmpfs volume takes its
place. A network-disabled helper keeps it mounted while MariaDB is stopped,
so sessions and test rows survive the outage. The runner removes the volume
with the test project. Chrome runs use temporary profiles that the helpers remove.

To run only the authentication lifecycle:

```sh
RUN_BROWSER_TESTS=1 python3 -B tests/integration/test_pipeline.py \
  PipelineTests.test_disposable_authentication_browser_lifecycle
```

## Focused development tests

For Python unit tests, use Python 3 on a Unix-like system and install
`requirements.txt` in your virtual environment.

```sh
python3 -B -m unittest discover -s tests -p 'test_*.py' -v
```

For standalone Node tests, use Node.js 24 or newer and install each package's
locked dependencies. See [backend tests](../../backend/README.md#tests) for
running against an isolated MariaDB instance and
[frontend tests, lint, and build](../../frontend/README.md#verification-and-build)
for React development.

## Deployment network and TLS

Use the [AWS deployment guide](../cloud_infrastructure/aws-db-initialization.md)
for the Fargate demo. On a VM deployment, check DNS,
routing, firewalls, and TLS separately. The checker needs outbound access
to NJIT Banner and the backend's HTTPS endpoint. Keep Express and MariaDB
ports off the checker VM's network path.

Terminate TLS at a trusted proxy in front of Nginx. Use
`APP_ENV=production`, set `APP_ORIGIN` to the exact HTTPS browser origin, and
set `API_SCHEME=https` so Nginx forwards the correct protocol. The setting
only changes the forwarded header. Any proxy in front of Nginx must also
allow the ingestion body size up to 5 MiB.

For a checker on a separate VM, put `CHECKER_API_URL` (the reachable HTTPS
base URL without `/api`), the shared `CHECKER_API_TOKEN`, `CHECKER_TERMS`,
`BANNER_REQUEST_DELAY`, and the desired `TZ` in a private environment file.
Keep the token separate from database and session credentials. Keep the
file out of Git and shell traces. The checker needs no database credentials.

If a connection fails, check DNS and routing from the checker VM and its
container, then verify the certificate hostname and chain. Keep Requests
certificate verification enabled. For a private CA, install its trust
chain in the checker image or mount a CA bundle and set
`REQUESTS_CA_BUNDLE` to the mounted file path. Run a single scheduled checker
and use the [operations guide](../operations.md#scheduling-and-monitoring) to
check logs after a scheduled slot.
