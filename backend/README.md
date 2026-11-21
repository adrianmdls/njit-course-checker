# Express backend

Express handles accounts, sessions, course search, watchlists, and Banner
ingestion. It uses a shared mysql2 connection pool for MariaDB. In Compose,
Nginx forwards `/api/` to `backend:3000`, which has no published host port.
See the [root README](../README.md#quick-start) to start the stack.

## API endpoints

| Method | Path | Request or result |
|---|---|---|
| GET | `/api/health` | Runs `SELECT 1`. Returns `200` when connected or `503` on failure. |
| POST | `/api/auth/register` | JSON with `username`, `email`, and `password`. Returns `201`. |
| POST | `/api/auth/login` | JSON with `identifier` (username or email) and `password`. Returns the user and a session cookie on success or `401` for invalid credentials. |
| GET | `/api/auth/me` | Returns the session user or `401` for a missing or expired session. |
| POST | `/api/auth/logout` | Send `{}`. Destroys the session, clears the cookie, and returns `204`. |
| GET | `/api/courses/options` | Returns searchable terms and the departments with active, linked sections. |
| GET | `/api/courses` | Returns matching sections and pagination. Requires `term` and `subject`. |
| GET | `/api/watchlist` | Returns `{"sections":[...]}` for the signed-in user. |
| POST | `/api/watchlist` | Send `{"section_id":123}`. Returns `201`, `409` for a duplicate, or `404` if the section is missing. |
| DELETE | `/api/watchlist/:sectionId` | Send `{}`. Returns `204` on removal or `404` if the user has no such watch. |
| GET | `/api/internal/sync/targets` | Returns distinct watched department/term pairs. |
| POST | `/api/internal/sync/department` | Accepts a department snapshot and returns counts for courses, sections, and status changes. |

## Authentication and watchlists

Registration accepts usernames of 3–50 letters, digits, or underscores, valid
email addresses, and passwords of 15–128 Unicode code points. Passwords are
hashed with Argon2id. Registration returns `409` for duplicate usernames or
emails. Log in after registration. The per-IP limits are 10 login attempts
per 15 minutes and five registration requests per hour. Further requests in
the window return `429`.

MariaDB stores sessions across backend restarts. Login regenerates the session
ID. The cookie is HttpOnly and SameSite=Lax, with a 30-minute idle timeout and a
session age limit of eight hours. In production it is also Secure and named
`__Host-njit.sid`. Ordinary authenticated requests renew the idle cookie.
`GET` and `HEAD /api/auth/me` leave the cookie alone so a delayed response
can't overwrite a newer login cookie.

Course search and watchlists require a session. Auth and watchlist mutations
require JSON, an exact `Origin` matching `APP_ORIGIN`, and the header
`X-Requested-With: NJIT-Course-Checker`. Auth JSON is limited to 8 KiB and
watchlist JSON to 1 KiB. Production requires HTTPS through the trusted proxy.
Auth, search, watchlist, and internal sync responses use `Cache-Control: no-store`.

Watchlist writes use the authenticated user's ID and a positive section ID up
to 4294967295. POST takes a JSON integer and DELETE takes a decimal path ID.
Watchlist routes reject query parameters. The database enforces one watch per
user and section. Existing watches on inactive or unlinked sections stay visible.
Deleting a watch only affects the signed-in user's list.

## Course search

`GET /api/courses/options` takes no query parameters. It returns
`{"terms":[{"code":"202710","departments":["CS","IT"]}]}`, with departments
sorted alphabetically. Only active sections linked to a course supply
departments. See [configuration](#configuration) for how terms are selected.

| Parameter | Values |
|---|---|
| `term` | Required six-digit Banner term ending in `10`, `50`, `90`, or `95` |
| `subject` | Required uppercase department code of up to 10 alphanumeric characters, starting with a letter |
| `query` | Optional number prefix such as `280` or a matching full code such as `CS 280`. Case and spacing are normalized. |
| `status` | `OPEN`, `CLOSED`, or `CANCELLED` |
| `sort` | `course` (default), `crn`, or `availability` (capacity minus enrollment) |
| `order` | `asc` (default) or `desc` |
| `limit` | Integer from 1 to 100, default 50 |
| `offset` | Integer from 0 to 2147483647, default 0 |

A number prefix starts with a digit and has up to 20 alphanumeric characters.
The API rejects unknown, repeated, or invalid parameters with `400`. SQL uses
bound values and an allowlist of sort columns. Availability sorting puts
unknown counts last. The response contains a `sections` array and a `pagination`
object with `limit`, `offset`, and `total`. Each section has a stable ID, a string
CRN, stored status, counts, and a UTC `last_checked_at` time when available.
Unsynchronized pairs return an empty list. All results come from MariaDB.

## Internal department synchronization

Send `Authorization: Bearer <CHECKER_API_TOKEN>` to either internal endpoint.
Express compares token digests with a timing-safe check before parsing JSON or
querying MariaDB. Keep the token private, separate from session credentials,
and out of browser code and logs. Both routes require HTTPS in production.

Both `/api/internal/sync/targets` and `/api/internal/sync/targets?watched_only=true`
return the same distinct watched department/term pairs, sorted by subject and
term. Watches on inactive and unlinked sections count. An empty watchlist
across all users yields `{"targets":[]}`. Other query values, repeated parameters,
and unknown keys return `400`. The Python checker filters the pairs against its
configured terms and department list and handles regular rotation separately.

The ingestion route takes JSON up to 5 MiB and up to 10,000 sections. Nginx has
the same ingestion limit and keeps its 1 MiB limit for other routes.

```json
{
  "subject": "CS",
  "term": "202710",
  "sections": [
    {
      "course": "CS 100",
      "title": "CS 100 - Roadmap to Computing",
      "crn": "12345",
      "section": "001",
      "status": "OPEN",
      "max_enrollment": 30,
      "current_enrollment": 20
    }
  ]
}
```

Express validates the whole snapshot before writing. Subject and term follow the
same rules as search. Each row needs a matching course subject, a five-digit
string CRN, a valid status, and unsigned 32-bit enrollment counts. Titles and
section labels must be nonempty and have limits of 255 and 20 characters,
respectively. Over-enrollment is allowed. Duplicate CRNs count once when their
normalized fields agree. Conflicting duplicates return
`400` with `crn` / `conflicting_crn`. Valid titles can differ across distinct
CRNs. The course gets the normalized title from its lowest CRN. The `validation`
object in a rejected snapshot response includes `field`, `reason`, and
`row_index` (zero-based, or null for an envelope error).

Express locks each department/term during a write and saves the course and
section upserts and the department completion timestamp in one transaction.
Failed writes roll back. Overlapping writes or a CRN owned by another subject
in the same term return `409`. Keep one checker producer because the lock
serializes writes without tracking snapshot order.

Sections are keyed by term and CRN so IDs and watches survive updates. Explicit
observations update and reactivate sections. Omitted rows keep their previous
values and timestamps. An empty snapshot only records department completion.
The response counts status changes on previously active sections. New or
reactivated sections establish a baseline. The response fields are `courses`,
`sections`, and `status_changes`. See [section activity](../docs/section-activity.md).

## Configuration

The defaults below apply in Compose unless marked otherwise.

| Variable | Purpose |
|---|---|
| `DB_HOST`, `DB_PORT` | MariaDB address (`db:3306`). A standalone backend requires the host and defaults the port to `3306`. |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Required database name, login, and password. |
| `DB_TLS_CA_FILE` | Optional PEM CA file. Set to `/app/rds-ca.pem` in the backend image for `us-east-1` RDS and use the RDS endpoint DNS name as `DB_HOST`. Leave unset for local Compose. |
| `PORT` | Express port, default `3000`. |
| `APP_ENV` | Compose defaults to `development` for local HTTP. Use `production` for HTTPS. A standalone backend requires one of these values. |
| `APP_ORIGIN` | Required exact browser origin without a trailing slash. Compose defaults to `http://localhost:8080`. Production requires an HTTPS origin. |
| `SESSION_SECRET` | Required session signing secret of at least 32 bytes. Changing it invalidates existing cookies. |
| `CHECKER_API_TOKEN` | Machine credential shared with the checker. An empty or unset token makes both internal routes return `503`. |
| `SEARCH_TERMS` | Search dropdown terms. Compose sets it from `CHECKER_TERMS`, which requires one or two terms for the checker. |

Setting `DB_TLS_CA_FILE` requires certificate- and hostname-verified TLS.
Unreadable or invalid CA files fail at startup. Connection failures never
retry over plaintext.

For a standalone backend, leaving `SEARCH_TERMS` unset uses terms from active,
linked catalog rows, newest first. Set it to `[]` to expose no terms, or give one
or two distinct six-digit term strings with valid Banner suffixes. The options
endpoint preserves the configured order and includes terms with an empty
department list. An empty string or any other invalid value prevents startup.
Term configuration controls the dropdown. Stored historical records, existing
watches, and direct searches for historical terms remain available. See the
[term code table](../docs/operations.md#banner-term-codes).

`API_SCHEME` sets Nginx's forwarded protocol. Use `https` only behind real TLS
termination. Compose's direct checker URL is for local HTTP. See the
[deployment checks](../docs/banner-smoke-test.md#deployment-network-and-tls)
for production.

## Database and migrations

MariaDB initializes a fresh volume from [01-schema.sql](../database/init/01-schema.sql).
For an existing volume, back up the database, inspect the schema, and apply
only missing migrations to `njit_course_checker` before starting the backend.

- [001-sessions.sql](../database/migrations/001-sessions.sql) creates the session
  table. Express checks for it on startup.
- [02-course-catalog.sql](../database/migrations/02-course-catalog.sql) adds
  `Courses` and links sections to the catalog. Inspect the schema first if
  `Sections.course_id` already exists.
- [03-cancelled-status.sql](../database/migrations/03-cancelled-status.sql)
  adds the `CANCELLED` section status.
- [04-section-activity.sql](../database/migrations/04-section-activity.sql)
  adds `Sections.is_active`. Follow the
  [activity migration instructions](../docs/section-activity.md#existing-volume-migration-manual-not-applied-by-this-change).
- [05-remove-snapshot-generation.sql](../database/migrations/05-remove-snapshot-generation.sql)
  is an optional, forward-only cleanup for experimental columns. Follow the
  [generation cleanup guide](../docs/snapshot-generation-cleanup.md#manual-migration-of-an-existing-volume).

## Tests

Use Node.js 24 or newer. From the repository root, install dependencies and
run the backend suite without MariaDB.

```sh
npm ci --prefix backend
env -u TEST_DB_PORT -u TEST_DB_HOST -u TEST_DB_PASSWORD npm test --prefix backend
```

The database tests skip when `TEST_DB_PORT` is unset. To include them, run this
from the repository root. It creates a fresh MariaDB with test-only credentials
and gives the test container access through its network namespace, with no
published database port.

```sh
(
  set -eu
  docker build -t njit-backend-test backend
  test_db=$(docker run -d --rm --network none --tmpfs /var/lib/mysql \
    -e MARIADB_ROOT_PASSWORD=test-only-password \
    -e MARIADB_DATABASE=njit_course_checker mariadb:lts)
  trap 'docker rm -f "$test_db" >/dev/null 2>&1 || true' EXIT

  attempts=0
  until docker exec "$test_db" healthcheck.sh --connect --innodb_initialized; do
    attempts=$((attempts + 1))
    if [ "$attempts" -ge 90 ]; then exit 1; fi
    sleep 1
  done

  docker run --rm --network "container:$test_db" \
    -e TEST_DB_HOST=127.0.0.1 -e TEST_DB_PORT=3306 \
    -e TEST_DB_PASSWORD=test-only-password \
    -v "$PWD/backend/test:/app/test:ro" -v "$PWD/database:/database:ro" \
    njit-backend-test sh -c 'node --test --test-concurrency=1 test/*.test.cjs'
)
```

To run the TLS integration cases, point `TEST_DB_HOST` and `TEST_DB_PORT` at a
disposable MariaDB server with a TLS certificate matching that hostname. Set
`TEST_DB_TLS_CA_FILE` to its CA and `TEST_DB_TLS_WRONG_HOST` to a second DNS
name for the same server that the certificate does not cover. The fixture must
accept plaintext so the tests can verify that failed TLS does not fall back.
Run `node --test backend/test/db-tls.test.cjs` from the repository root.

Never point these tests at an application database. They create and delete
test schemas and rows and install a failure trigger. Run them serially because
MariaDB advisory locks are shared across schemas. The
[Banner smoke-test guide](../docs/banner-smoke-test.md#disposable-automated-verification)
covers the cross-service pipeline and optional Chrome tests.
