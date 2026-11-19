# Phase 3: persistent watchlists

> Historical record. Explicit monitoring targets were retired on November 19,
> 2026. Both target endpoint forms now return distinct watched pairs. See
> [current operations](operations.md#scheduling-and-monitoring).

The browser watchlist now uses authenticated Express routes and the existing
MariaDB Watchlists table. Phase 1 parsing and Phase 2 scheduling are unchanged.
There are no new tables, migrations, dependencies, notifications or Banner calls.

## API and ownership

- `GET /api/watchlist`: `200 {"sections": [...]}` for the session user only.
- `POST /api/watchlist`: numeric JSON `section_id` only; `201` on creation,
  `409` when already watched, `404` for a missing Section.
- `DELETE /api/watchlist/:sectionId`: positive decimal section ID with an empty
  JSON body; `204` on deletion, `404` if absent from the current user's list.

All routes use the same session middleware/user lookup as course search.
Authentication failures are `401`, including machine Bearer tokens without a
browser session. Mutations reuse the auth API's Origin/custom-header/JSON checks;
body parsing is limited to 1 KiB. Unknown body fields (including user IDs), invalid
IDs, and query parameters are rejected. Production requires HTTPS. Responses are
not HTTP-cached. See the backend guide for detailed status codes.

All SQL values are parameterized. Inserts select the Section in the same
statement and rely on `uq_user_section` to prevent duplicate/concurrent additions.
Deletes always include both `user_id` and `section_id`. A section ID is not a
Watchlists row ID. List data comes from stored Sections/Courses and includes
course, title, CRN, term, section, enrollment/capacity, stored status and last
checked time. Legacy unlinked Sections remain visible with nullable fields and a
saved-label/subject fallback. Listing or changing watches never fetches Banner,
changes course/section records, or advances DepartmentSyncs timestamps.

## Browser behavior

The dashboard loads the current user's list on mount and tab changes, with a
loading state and retry action. Search's Add controls remain disabled until
membership is known. Membership and list keys use database section IDs, allowing
the same CRN in different terms. A mutation ref prevents duplicate rapid clicks;
pending controls stay disabled until the server responds. State changes only
after successful requests, or a known duplicate/already-removed response from a
cross-tab/retry operation. Old list responses cannot overwrite a newer mutation.

The watchlist preserves the existing table/tabs/colors and horizontal scrolling
on narrow screens, adds the term column, and displays stored Open/Closed/Cancelled
or Unknown status. Add/Remove errors retain data and allow retry. Reloading the
page or creating a new app instance reads the persisted list. Expired sessions
use the existing auth refresh/route guard. The mock email notification toggle is
removed; no notification feature has been implemented.

There is no cross-tab push or automatic background list refresh. Reopening a tab
reloads membership and current availability; a duplicate POST `409` or absent
DELETE `404` reconciles membership safely. Lists are not paginated in this phase.

## Scheduler integration

No scheduler or internal-target code changes are needed. Committed watch rows
already participate in the Watchlists/Sections join used by
`GET /api/internal/sync/targets?watched_only=true`. The pair remains prioritized
while any section in that subject/term is watched by any user. Removing its final
watch removes that pair from the endpoint. The checker picks up changes at its
existing ticks and pre-fetch membership rechecks, subject to its configured terms
and NJIT allowlist. Watches outside those filters remain stored but are not
priority-polled. The unfiltered endpoint still includes explicit monitoring
targets; those do not become actual watches.

## Verification

The new Express suite uses real auth middleware and a separate random schema on
an explicitly disposable MariaDB server. It tests authentication, mutation-origin
protection, validation, duplicate/concurrent additions, owner-scoped SQL,
cross-user isolation, legacy/null data, persistence across app instances with the
same session, safe failures, matching CRNs in different terms, and promotion/
demotion across multiple users and sections. Existing sync/search tests still run.

The real Chrome integration check runs React → Nginx → Express → MariaDB without
mocking successful API responses. It covers failed Add, rapid duplicate clicks,
Added state after reload, stored watchlist data, watchlist load/retry, failed
Remove preserving the row, successful Remove persisting across reload, search
pagination/filtering and session expiry. Temporary desktop/mobile captures support
visual inspection. Browser-created watches are removed before the integration
runner compares all original catalog, section, watchlist and sync records.

Run the existing Python suite, `npm test --prefix backend` with a disposable test
database, frontend lint/build, and `RUN_BROWSER_TESTS=1 python3 -B
tests/integration/test_pipeline.py`. Never set TEST_DB_PORT to an application DB.
Only test-owned tmpfs containers/schemas are created/removed; no application
volume, existing container or live Banner endpoint is used.

## Changed files and results

Files changed for Phase 3:

| File | Purpose |
|---|---|
| `backend/src/watchlist.js` (new) | Session-scoped list/add/remove routes and parameterized ownership checks. |
| `backend/src/auth.js` | Export the existing mutation-origin guard for reuse without changing auth behavior. |
| `backend/src/server.js` | Mount `/api/watchlist`. |
| `backend/test/watchlist.test.cjs` (new) | Real auth/validation checks and isolated MariaDB ownership, persistence and target tests. |
| `frontend/src/pages/Dashboard.jsx` | Load/mutate persisted watches, retry/loading states, stored availability and term display. |
| `frontend/src/components/SearchCourses.jsx` | Section-ID membership and pending/Added button states. |
| `tests/integration/course_search_browser.mjs` | Real persistent Add/reload/Remove, failure/retry, duplicate clicks and visual captures. |
| `README.md`, `backend/README.md`, `frontend/README.md` | Current functionality and API contract. |
| `docs/operations.md`, `docs/banner-smoke-test.md`, this document | Operational behavior, verification and limits. |

Results:

- Python: **65 passed**, no failures/skips; scheduler tests are unchanged.
- Express with a fresh disposable MariaDB server: **18 passed**, no failures/skips.
- Integration with `RUN_BROWSER_TESTS=1`: **15 passed**, including real Chrome
  empty-catalog and populated-catalog/watchlist checks.
- Frontend `npm run lint` and `npm run build`: passed.
- `git diff --check`: passed.
- Desktop (1280 px) and mobile (390 px) watchlist captures were visually inspected;
  the responsive header/tabs and horizontally scrollable table remain intact.
- Test database containers/stacks and the temporary Chrome profile were removed.
  The application stack, existing volume, scheduler, scraping, polling intervals,
  schema and migrations were not modified. No live Banner requests were made.
  Pre-existing unrelated working-tree edits were retained. No staging/commits.

Stop for review. Deployment/recreation of the running application is outside this
implementation run. Watches are stored immediately, but the next eligible
checker tick determines when Banner is polled; there is no on-demand refresh.
