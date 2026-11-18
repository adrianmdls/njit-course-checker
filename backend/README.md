# Express Backend

Express provides authentication, course search, internal Banner snapshot ingestion, and a database health check. Nginx forwards `/api/` requests to `backend:3000`, and Express uses a shared mysql2 connection pool to reach MariaDB at `db:3306` over the Compose network. The backend has no published host port.

For installation, environment setup, and database initialization, see the [root README](../README.md).

## API Endpoints

| Method | Path | Request / result |
|---|---|---|
| GET | `/api/health` | Runs `SELECT 1`; returns `200` when connected or `503` when unavailable |
| POST | `/api/auth/register` | `{username, email, password}`; creates an account (`201`) |
| POST | `/api/auth/login` | `{identifier, password}`; username or email login, returns user details (`200`) or invalid credentials (`401`) |
| POST | `/api/auth/logout` | `{}`; destroys the session and clears the cookie (`204`) |
| GET | `/api/auth/me` | Returns the current user (`200`) or unauthenticated/expired session (`401`) |
| GET | `/api/courses/options` | Session-authenticated locally available terms and departments (`200`) |
| GET | `/api/courses` | Session-authenticated section search; requires `term`, returns sections and pagination (`200`) |
| GET | `/api/internal/sync/targets` | Bearer-authenticated unique Watchlist and explicit subject/term pairs (`200`) |
| POST | `/api/internal/sync/department` | Bearer-authenticated department snapshot; returns processed course, section, and status-change counts (`200`) |

Registration requires a username of 3–50 letters, digits, or underscores and a password of 15–128 Unicode code points. Invalid registration input returns `400`; duplicate username/email returns `409`.

Authentication POST requests require JSON, an `Origin` matching `APP_ORIGIN`, and `X-Requested-With: NJIT-Course-Checker`. The React request helper supplies the application headers; the browser supplies Origin.

## Course search

`GET /api/courses/options` accepts no query parameters and returns, for example,
`{"terms":[{"code":"202710","departments":["CS","IT"]}]}`. Terms sort newest
first; departments sort alphabetically. Options use distinct term/subject pairs
from the same joined section/catalog records as search. Unlinked legacy sections
and courses without sections are excluded. An empty catalog returns
`{"terms":[]}`. It shares search authentication, no-store/HTTPS controls and
sanitized `503` handling; unexpected query parameters return `400`.

`GET /api/courses` reads existing MariaDB course and section records. It uses the
same session middleware, cookie, session store, and `requireAuth` user lookup as
`/api/auth`; log in first and send the session cookie. Checker Bearer tokens do
not authenticate this endpoint. Responses use `Cache-Control: no-store`.
Production requires HTTPS through the trusted proxy.

| Parameter | Values |
|---|---|
| `term` | Required six-digit Banner code ending in `10`, `50`, `90`, or `95` (Winter) |
| `subject` | Optional uppercase department code, starting with a letter, at most 10 alphanumeric characters |
| `query` | Optional course number prefix, such as `280`, or full code, such as `CS 280`; case and whitespace are normalized |
| `status` | Optional stored `OPEN`, `CLOSED`, or `CANCELLED` status |
| `sort` | `course` (default), `crn`, or `availability` |
| `order` | `asc` (default) or `desc` |
| `limit` | Integer from 1 to 100; default 50 |
| `offset` | Integer from 0 to 2147483647; default 0 |

Unknown parameters, duplicate parameters, invalid values, and conflicting
subjects in `subject` and `query` return `400`. A course number prefix starts
with a digit and contains at most 20 alphanumeric characters; raw queries are
limited to 100 characters. Pagination accepts decimal digits only.

Examples using a cookie jar saved during login:

```sh
curl -b cookies.txt 'http://localhost:8080/api/courses?term=202710&subject=CS'
curl -b cookies.txt 'http://localhost:8080/api/courses?term=202795&query=CS%20280&status=OPEN'
curl -b cookies.txt 'http://localhost:8080/api/courses?term=202710&sort=availability&order=desc&limit=20&offset=20'
```

The response is `{ "sections": [...], "pagination": { "limit": 50, "offset": 0,
"total": 123 } }`, with one record per linked section. Each record contains
`id`, `course`, `subject`, `course_number`, `title`, `term`, `crn`, `section`,
`max`, `now`, `status`, and `last_checked_at`. CRNs remain strings, nullable
fields remain null, and timestamps use UTC ISO 8601. Status comes from the stored
record. No matches return an empty array and total zero; an offset beyond the
results returns an empty array while retaining the matching total.

Course sorting uses subject, course number, and section number. Availability
sorting uses capacity minus enrollment, supports over-enrollment, and places
unknown availability last in either direction. All sorts use section ID as a
final tie-breaker and apply the requested direction to every tie-breaker.
Missing, invalid, or expired sessions return `401`; database failures return a
sanitized `503`. Searches never request data from Banner.

## Persistent watchlists

All three routes reuse the existing session middleware and user lookup. Checker
Bearer tokens do not authenticate these routes. Responses use `Cache-Control:
no-store`; production requires HTTPS through the trusted proxy.

| Method | Path | Behavior |
|---|---|---|
| GET | `/api/watchlist` | `200 {"sections": [...]}` for the current user; empty arrays are valid. |
| POST | `/api/watchlist` | JSON `{"section_id": 123}`; `201 {"section_id": 123}`, duplicate `409`, nonexistent section `404`. |
| DELETE | `/api/watchlist/:sectionId` | `204` on removal, `404` if the current user has no such watch. Send an empty JSON object. |

Mutations require an exact `Origin`, `X-Requested-With: NJIT-Course-Checker` and
`Content-Type: application/json`, reusing auth protections. Invalid origins or
headers return `403`, non-JSON mutations `415`, malformed JSON `400`, and JSON
bodies over 1 KiB `413`. Authentication failures return `401` before watchlist
queries. Invalid IDs/body fields or any query parameters return `400`.

POST section IDs must be JSON integers from 1 to 4294967295. DELETE path IDs use
canonical positive decimal digits in the same range. User IDs are never accepted;
unknown fields, including `user_id`, are rejected. All database values are bound
parameters, and deletion always includes the authenticated owner. A `404` does
not reveal whether another user's watch exists. Database failures are sanitized
by the existing server error handler.

List rows contain `section_id`, `course`, `title`, `subject`, `crn`, `term`,
`section`, `max`, `now`, `status`, boolean `is_active` and UTC ISO `last_checked_at`. Nullable values
stay null. Status is stored status rather than an inference from available seats.
Legacy sections without a course link remain visible using their saved label or
subject; no placeholder Course rows are created.

The existing unique `(user_id, section_id)` key prevents concurrent duplicates.
Insertion checks section existence in the same SQL statement. No additional
Watchlists table changes are required. The watched-only internal targets endpoint immediately reflects
committed additions/removals across all users. Removing one user's watch does
not demote a pair still watched elsewhere. Scheduler term/allowlist filtering and
polling times are unchanged. See [Phase 3 notes](../docs/phase-3-watchlists.md).

## Internal department synchronization

Set a separate, random `CHECKER_API_TOKEN` (generate with `openssl rand -hex 32`). Compose passes it to the backend. An unset/empty token disables ingestion with `503`, without disabling the rest of the backend. Recreate the backend container after changing the token. Send `Authorization: Bearer <CHECKER_API_TOKEN>` and `Content-Type: application/json`. Production requires HTTPS through the trusted proxy. Keep the token out of browser code, URLs, and logs.

The endpoint uses machine credentials independently of browser sessions. It does not accept cookies as authentication or require browser Origin/CSRF headers; the existing `/api/auth` protections remain in effect. Token digests are compared with Node's timing-safe comparison, including for tokens with different lengths. Authentication runs before JSON parsing or database access. Bodies are limited to 5 MiB and 10,000 section entries (zero entries are allowed).

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

Validation failures include fixed `validation.field`, zero-based `validation.row_index` (null for envelope errors), and `validation.reason` diagnostics; raw values are never echoed. See [Phase 1 notes](../docs/phase-1-sync.md) for parser and allowlist verification limits.

`sections` uses the existing `parse_all_sections()` field names. Other scraper fields are ignored. Only an exact matching `course + " - "` prefix is removed from a title; other title text is preserved. Subject must be uppercase alphanumeric, start with a letter, and contain at most 10 characters. Term is a six-digit string with Banner suffix `10`, `50`, `90`, or `95` (Winter), matching the existing checker. Course identifiers use `SUBJECT NUMBER`, separated by whitespace; the number starts with a digit and contains at most 20 uppercase alphanumeric characters. The course subject must match the snapshot. CRNs are five-digit strings. Titles and section labels must be nonempty and fit their schema limits of 255 and 20 characters. Enrollment values are nonnegative unsigned 32-bit integers; over-enrollment is allowed. Status must be `OPEN`, `CLOSED`, or `CANCELLED`. Empty arrays are accepted as nondestructive successful synchronization: only the department completion timestamp changes. Conflicting course titles and conflicting duplicate CRNs are rejected. Identical duplicate CRNs count once.

No capture timestamp is required; `snapshot_started_at` is ignored if supplied. The department lock prevents overlapping writes, but does **not** detect out-of-order snapshots. The polling caller must fetch and submit each snapshot sequentially, waiting for completion before the next fetch. If submission fails or times out, finish retrying that snapshot before sending another, or discard it and fetch a fresh snapshot. Do not send delayed retries after submitting newer data. Parallel producers would require snapshot ordering protection in a later change.

Example response:

```json
{"courses":1,"sections":1,"status_changes":0}
```

Counts refer to unique supplied courses/sections. New or reactivated sections do not count as status changes. For already active sections, any different stored status (including NULL) counts once. Repeated identical requests report zero status changes, create no duplicate records, and refresh observed sections' `last_checked_at` and department `last_synced_at`. Courses upsert by `(subject, course_number)` and sections by `(term, crn)`. Existing section IDs and Watchlist references survive; watched and unwatched sections receive the same updates, including legacy rows with a NULL course link. A CRN already owned by another subject in that term returns `409`.

Validated complete nonempty snapshots mark omitted sections inactive within the
same transaction, preserving their stored Banner status and last-seen fields.
Returning sections reactivate. Empty snapshots preserve all section activity until
real Banner empty-result semantics are verified. Search/counts/catalog options
exclude inactive sections; watchlists include them and both APIs expose boolean
`is_active`. Inactive watched sections still contribute monitoring targets.
See [activity behavior and the required existing-volume migration](../docs/section-activity.md).

All writes and the successful `DepartmentSyncs.last_synced_at` completion timestamp share one transaction. A MariaDB advisory lock named `njit:sync:<subject>:<term>` rejects overlapping API requests with `409` across backend instances. Row locks protect comparisons and updates; the advisory lock is released before returning the connection to the pool. Database failures roll back the transaction and return `503` through the backend error handler. Other responses include `400` for invalid input/JSON, `401` for invalid credentials, `413` for oversized JSON, and `415` for a non-JSON content type.

`GET /api/internal/sync/targets` uses the same Bearer authentication and production
HTTPS requirement as ingestion. It requires no request body or browser session.
It returns, for example:

```json
{"targets":[{"subject":"IT","term":"202795"}]}
```

With `?watched_only=true`, the same endpoint returns only distinct database
Watchlist subject/term pairs. The scheduled checker uses this filter, then limits
pairs to its configured terms and NJIT allowlist. Other query values, duplicate
parameters and unknown keys return `400` before accessing the database.

Without a query, targets retain the backwards-compatible merge of distinct Watchlist subject/term pairs with the backend-only
`CHECKER_MONITORING_TARGETS` JSON array (default `[]`). Duplicates collapse to one
pair; NULL course links and catalog presence do not imply monitoring. An empty
result is `{ "targets": [] }`. The endpoint does not write data. Explicit target
configuration accepts the same subject and term formats as ingestion; malformed
configuration prevents startup. See the [legacy monitoring upgrade notes](../README.md#banner-department-synchronization)
before deploying against an existing database.

Python polling and manual checks use HTTP only. Express owns all monitoring
reads, section writes, status comparisons, and synchronization timestamps. The
standalone legacy Python search helper retains SQL cache reads outside the
polling architecture. No notifications are sent by these endpoints.

## Tests

Run `cd backend && npm test` for authentication and validation tests. Database tests are skipped unless `TEST_DB_PORT` is set. To run the full suite, start an isolated, disposable MariaDB instance with a database named `njit_course_checker`, root password `test-only-password`, and a published localhost port, then run:

```sh
cd backend
TEST_DB_PORT=<disposable-database-port> npm test
```

Use a fresh database for each run; the suite creates schema, users, Watchlists, and a failure-injection trigger. Never point these tests at an application database. The full suite checks real MariaDB upserts, section ID preservation, watched/unwatched updates, status changes, rollback of existing and new records, completion timestamp rollback, retries, caller-controlled snapshot ordering, Winter terms, subject collisions, and lock contention. It uses Node's test runner and existing dependencies.

Course search tests additionally cover session authentication, invalid parameters
and injection attempts, normalized prefixes and full course codes, filters,
all sort directions, pagination totals and stable ordering, empty results,
nullable values, and sanitized failures. The MariaDB search test creates and
drops a separate randomly named schema on the disposable server, exercises
real registration/login/logout, and injects a SQL failure without affecting the
sync suite's schema. All database tests run when `TEST_DB_PORT` is supplied.

## Authentication

Passwords are hashed with Argon2id. Login regenerates the session ID; MariaDB stores session data while an HttpOnly, SameSite=Lax cookie identifies the session. Sessions survive backend restarts, expire after 30 minutes idle or eight hours total, and are destroyed on logout. Registration does not automatically log users in.

Email verification and password reset are not implemented; unverified users may log in. Login and registration are rate limited.

## Configuration Notes

Compose supplies these backend variables:

| Variable | Purpose |
|---|---|
| `DB_HOST`, `DB_PORT` | Database address (`db:3306` in Compose) |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Database name and credentials |
| `PORT` | Express listening port (`3000`) |
| `APP_ENV` | `development` permits local HTTP; `production` requires HTTPS and Secure cookies |
| `APP_ORIGIN` | Exact browser origin, without a trailing slash; defaults to `http://localhost:8080` |
| `SESSION_SECRET` | Required signing secret, at least 32 bytes; changing it invalidates existing cookies |
| `CHECKER_API_TOKEN` | Bearer credential for internal ingestion and monitoring targets; empty disables both |
| `CHECKER_MONITORING_TARGETS` | Backend-only JSON array of explicit `{subject, term}` pairs; defaults to `[]` |

The `sessions` table must exist before startup; MariaDB initializes it automatically for new Compose database volumes. Existing volumes require any missing migrations to be applied manually. Express does not create the table. `API_SCHEME` configures Nginx's forwarded protocol, not TLS itself. Keep the local values from `.env.example` for the Compose demo.
