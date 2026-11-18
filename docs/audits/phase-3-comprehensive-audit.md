# Phase 3 comprehensive audit

Audit date: November 17, 2026, America/New_York.

Scope: the current working tree on `feature/scheduled-course-sync`, including the
uncommitted Phase 3 implementation. This is a review, not an implementation.
Application code, configuration, database contents, Git refs, staging, and running
services were not changed. This report is the only new repository artifact.

## 1. Executive summary

The project has a coherent Banner ingestion pipeline, a well-tested sequential
scheduler, authenticated database-only search, and a persistent watchlist
implementation. Milestone 3 is **not complete**: automatic email notifications
are absent. Production readiness also requires resolving configuration and
verification gaps described below.

The most important findings are:

1. Sections omitted from a later complete snapshot keep their previous status
   indefinitely and remain searchable. Even a successful empty snapshot advances
   department freshness without changing those sections. This is documented
   behavior, but it leaves a significant availability correctness gap.
2. The auth provider has reproducible response-ordering and error-state defects:
   a late initial session check can undo a successful login, and a successful
   login does not clear a previous session-check error.
3. Deployment configuration needs attention. The local `.env` has no
   `CHECKER_TERMS`; `docker compose config --quiet` fails before any daemon
   access. Production ingestion must use an actual HTTPS proxy URL rather than
   the development default `http://backend:3000`.
4. The supplied Nginx config and Express ingestion accept different maximum body
   sizes. A valid synthetic 1,377,045-byte snapshot exceeds Nginx's default but
   fits Express's 5 MiB limit. Proxy-path ingestion is not covered by the existing
   fixture submission tests.
5. The scheduler's cursor, request gate, crash repetition, and regular-work
   priority are supported by passing deterministic tests. Its cadence has
   intentional limits: a regular rotation takes 41 hours, a large watched batch
   exceeds ten minutes, and failures consume regular turns.

Verification completed: **65 Python tests passed; 11 additional in-process audit
probes passed; frontend lint and production build passed; source syntax and
manifest/lockfile consistency checks passed.** The normal Express run reported
one pass, 14 failures caused by sandbox `listen EPERM`, and three database skips.
These are environmental restrictions, not evidence of 14 application defects.

Docker socket access was denied. Existing containers, container logs, live schema,
database counts, and actual volume mounts could not be inspected. No permission
escalation was requested. No live Banner requests were made. Previous test
successes recorded in Phase 1–3 documents are historical claims, not results
reproduced by this audit.

## 2. Current implementation and repository status

### Git baseline

- Current branch: `feature/scheduled-course-sync`.
- HEAD: `c8f9ead` (`feat: implement scheduled course synchronization`).
- `multi-container`: `a829d24`, the base before Phase 1/2 changes.
- Commits since that base: `1d75937` (Banner hardening) and `c8f9ead` (scheduling).
- Preserved experimental `feature/persistent-watchlists`: `599cce9`.
  It contains three divergent commits concerning department selection,
  versioned snapshots/monitoring, and refresh diagnostics. Those features are
  not the current Phase 3 watchlist CRUD implementation.
- Nothing was merged, cherry-picked, staged, committed, or switched.

At audit start, 13 tracked files were modified: `Dockerfile`, `README.md`,
`backend/README.md`, `backend/src/auth.js`, `backend/src/department-sync.js`,
`backend/src/server.js`, `backend/test/department-sync.test.cjs`,
`docs/banner-smoke-test.md`, `docs/operations.md`, `frontend/README.md`,
`frontend/src/components/SearchCourses.jsx`, `frontend/src/pages/Dashboard.jsx`,
and `tests/integration/course_search_browser.mjs`.

Three Phase 3 files were untracked: `backend/src/watchlist.js`,
`backend/test/watchlist.test.cjs`, and `docs/phase-3-watchlists.md`. The tracked
changes totaled 266 additions and 100 deletions. The audit preserves them.
**Release gate:** HEAD alone does not contain the reviewed Phase 3 implementation;
any later release must include all intended files together. In particular,
`backend/src/server.js:6` requires the currently untracked watchlist module.

The tracked working-tree diff from `multi-container` spans 30 files; that count
does not include untracked files. A direct ref comparison with the experimental
branch spans 49 files and is not a clean implementation plan. Do not import its
on-demand search refresh service merely to obtain watchlists.

### Feature status

| Area | Audit assessment |
|---|---|
| Phase 1 ingestion | Implemented; conservative parser and API validation verified offline; real Banner compatibility remains unverified. |
| Phase 2 scheduling | Implemented; 33 scheduler tests pass within the 65-test Python suite. |
| Phase 3 watchlists | Implemented in the working tree; owner-scoped routes, stable IDs, persistence SQL, and UI reviewed; real DB/browser checks blocked here. |
| Course search | Implemented through authenticated local SQL API, including filters, ordering, and pagination. |
| Email notifications | Not implemented. |
| Email verification/password reset | Not implemented; unverified accounts may log in (`backend/README.md:207`). |
| VMware production deployment | Instructions and partial setup notes exist; full runtime topology, TLS, and current code deployment are unverified. |

### Dependencies, generated files, and simplification

Both JavaScript packages have lockfiles whose root dependency declarations match
their manifests. Installed direct dependencies satisfy `npm ls --depth=0` in both
packages. Backend requires Node >=24; this audit used Node 26.13.0 and Python
3.14.10. Python's three direct requirements are pinned, but transitive dependencies
are not locked with hashes. `pip check` reports no broken requirements.
No dependency vulnerability database or container image scan was performed;
passing these checks does not establish absence of vulnerable dependencies.

No `.env`, runtime cursor, logs, database state, node_modules, or build output is
tracked. A limited current-tree pattern scan found no private-key blocks, AWS
access keys, GitHub token patterns, or actual Discord webhook credentials. A
targeted all-ref history search found only placeholder webhook URLs in historical
operations documentation; `.env` has no all-ref file history. This was not a
complete secret scanner over every historical blob.

Simplification opportunities, without changing normal behavior:

- Remove unused `frontend/src/data/mockCourses.js`; it has no importers.
- Consider retiring the documented legacy `src/course_search.py` and
  `src/database.py` SQL path, then remove PyMySQL if no supported caller needs it.
  React and the scheduler do not use it. Its 30-minute freshness model differs
  from the 41-hour rotation and can create a competing Banner producer if revived.
- Retire or clearly isolate unused notification formatting (`src/output.py:34`)
  and manual-only Discord support when implementing backend-owned email delivery.
- Keep the two scheduling loops and existing gate; no evidence justifies adding
  a broker, parallel fetch pool, or experimental refresh service for Milestone 3.

## 3. Tests executed and results

| Check | Result and limits |
|---|---|
| `.venv/bin/python -B -m unittest discover -s tests -p 'test_*.py' -v` | **65 passed**: checker, API client/helper, parser/allowlist, and scheduler. All upstream calls mocked; cursor files temporary. |
| `env -u TEST_DB_PORT npm test --prefix backend` | **1 passed, 14 failed, 3 skipped**. Every failure was `listen EPERM: operation not permitted 127.0.0.1`, before useful HTTP assertions. No disposable DB selected. |
| Additional in-process audit probes | **11 passed**, described below. No sockets or real DB. |
| `npm run lint --prefix frontend` | Passed, no reported lint diagnostics. |
| `npm run build --prefix frontend -- --outDir /private/tmp/njit-audit-build-20261117 --emptyOutDir false` | Passed. Output went outside the repository; no existing frontend build replaced. |
| `node --check` on backend source/tests and integration browser script | Passed. |
| Python AST parse on source, unit tests, and integration Python files | Passed. |
| Manifest/lockfile root declarations; both `npm ls --depth=0` | Passed. |
| `.venv/bin/python -m pip check` | Passed; pip cache was disabled because its cache directory was not writable. |
| `git diff --check` | Passed on the existing implementation changes. |
| `docker version` / `docker ps` | Docker client 29.8.2 available; daemon socket access denied. No container metadata returned. |
| `docker compose config --quiet` | Failed safely: required `CHECKER_TERMS` missing from the local configuration. |
| Disposable MariaDB Express/integration tests | Not run: Docker unavailable and no local MariaDB server binary found. |
| Existing isolated browser tests | Not run: their disposable stack requires Docker; local listener permission is also unavailable. |
| Live Banner and existing DB writes | Intentionally not run under the audit rules. |

The 11 additional probes evaluated copies of the actual source in memory, without
editing it. They covered: parsed valid fixture acceptance; actual ingestion route
400 for conflicting titles without SQL access; identical/conflicting CRNs;
subject mismatch; production HTTP rejection; empty sync SQL behavior; omission
handling; rollback/lock-release call sequence under injected failure; a valid
oversized proxy payload; late session-check/login ordering; and retained auth
errors after login. The SQL probes used a recording fake connection: they verify
application control flow and generated statements, **not MariaDB transaction or
locking semantics**. Auth probes executed the provider's actual callbacks with
controlled hook setters/promises; they are not full React/browser tests.

Temporary probe/build files were created under `/private/tmp` and cleaned after
their results were recorded. No production test credentials or secrets were used.

### Test infrastructure safety review

`tests/integration/test_pipeline.py:35` creates a unique Compose project and uses
`--env-file /dev/null`. Its database uses tmpfs (`tests/integration/compose.yaml:8`)
and no existing MariaDB volume. Fixture Banner responses are patched in
`tests/integration/checker_probe.py:103`; the checker test also rejects SQL imports
and DB environment variables. The runner deletes data only inside its own stack.
The search/watchlist DB unit tests create randomly named schemas on an explicitly
disposable server. The sync DB test uses the fixed `njit_course_checker` schema,
adds compatibility columns and failure triggers, and must never receive an
application DB port (`backend/test/department-sync.test.cjs:162`).

The legacy `backend/test/auth.browser.cjs` is unsafe for this audit: it defaults
to the application origin, executes root Compose database writes, restarts the
backend, and stops/starts the DB (`:5`, `:11`, `:55`, `:64`).
`backend/test/production.cjs:27` also writes through the ambient database pool.
Neither script was run. See F7 for the recommended isolation change.

## 4. Confirmed defects and implementation gaps

Severity describes user/deployment impact, not a CVSS score. A conditional blocker
is identified explicitly. Intentional behavior can still be a product gap.

### F1 — Automatic email notifications are absent

- **Evidence:** `README.md:23`, `docs/operations.md:90`, and
  `backend/src/department-sync.js:64`/`:89`. Ingestion counts status changes but
  stores no notification event. No email sender, SMTP/provider integration,
  delivery queue, or automatic email call site exists. Retained
  `src/discord_notify.py:13` is manual-only and is not called by the scheduler.
- **Impact:** Watching a section never produces an automatic email.
- **Severity:** High deliverable gap.
- **Recommended fix:** Produce per-section availability events in the backend
  ingestion transaction, persist notification work, and deliver through one
  backend-owned worker with retry and duplicate protection. Verify recipient
  consent/ownership before enabling outbound mail.
- **Blocks deployment:** Blocks claiming Milestone 3 complete; does not prevent
  a clearly described search/watchlist preview.

### F2 — Missing sections remain searchable with obsolete availability

- **Evidence:** `backend/src/department-sync.js:66` through `:88` only upserts
  supplied rows and department completion. It has no absent-row update.
  `backend/src/courses.js:55` and `:63` have no active/latest-snapshot filter;
  `backend/src/watchlist.js:20` returns stored status unchanged. The empty-sync
  probe issued no Sections statement but did update DepartmentSyncs. The
  nonempty probe likewise issued no omission/deactivation statement.
- **Impact:** If an OPEN section disappears, it can remain OPEN indefinitely in
  search and watchlists. A department's successful sync timestamp does not prove
  every retained section was observed in that snapshot. Watches and priority
  targets also persist, which preserves user intent but does not resolve status.
- **Severity:** High data correctness gap, already documented as deferred work.
- **Recommended fix:** After a verified complete snapshot, atomically mark absent
  rows inactive/unavailable while preserving section IDs and watches. Reactivate
  returning rows. Hide inactive rows in normal search and show an explicit
  unavailable state on existing watches. Absence must not be reported as an
  authoritative Banner CANCELLED status. Decide empty-snapshot semantics only
  after its real upstream shape is verified.
- **Blocks deployment:** Blocks presenting results as reliably current course
  availability; a preview needs clear freshness/availability limits.

### F3 — Auth refresh responses can overwrite newer login state

- **Evidence:** `frontend/src/auth.jsx:25` updates user/error state without a
  request generation or cancellation guard; its mount effect at `:33` does not
  cancel. `login` at `:34` sets the user but does not clear `error`. In controlled
  execution of these actual callbacks, resolving login before rejecting the old
  `/me` request with 401 changed user back to null. A `/me` 503 followed by a
  successful login retained the error, which `RequireAuth` renders at `:48`.
- **Impact:** A successful login can return to the login screen or encounter a
  stale session-check error, particularly on a slow or recovering backend.
- **Severity:** Medium functional defect; no backend authentication bypass found.
- **Recommended fix:** Invalidate older session requests when login/logout starts,
  guard state updates by request generation, clear obsolete auth errors on
  success, and make the refresh callback stable. Test delayed `/me` responses
  around login/logout and 503 recovery.
- **Blocks deployment:** Should be fixed before a reliable multi-user release;
  not the Milestone 3 email blocker.

### F4 — Ingestion's proxy body limit is smaller than the API contract

- **Evidence:** Express allows `5mb` at `backend/src/department-sync.js:147`.
  `frontend/nginx.conf:8` has no body-limit override. Nginx documents a default
  `client_max_body_size` of 1m and rejection with HTTP 413.
  [Nginx directive documentation](https://nginx.org/en/docs/http/ngx_http_core_module.html#client_max_body_size).
  A 1,500-section synthetic payload with valid fields and 600-character comments
  passed the actual validator and serialized to 1,377,045 bytes. Fixture
  submissions use `http://backend:3000` in `tests/integration/compose.yaml:66`,
  bypassing Nginx. No running Nginx config or actual large Banner department was
  available to test.
- **Impact:** A department accepted directly by Express can fail via the required
  production HTTPS proxy. Extra parsed fields consume body space despite not
  being stored (`src/njit_scraper.py:130`, `backend/src/department-sync.js:41`).
- **Severity:** Medium confirmed configuration/contract mismatch; real-world
  payload frequency remains unknown.
- **Recommended fix:** Set a consistent bounded proxy limit for ingestion and
  submit only persisted fields. Add a representative large fixture through the
  actual proxy path. Do not remove body limits globally.
- **Blocks deployment:** Conditional blocker for affected departments or a
  deployment promising the documented 5 MiB ingestion contract.

### F5 — A separate ingress proxy collapses per-client auth rate limits

- **Evidence:** The documented production topology puts a TLS proxy in front of
  loopback Nginx (`.env.example:24`). Nginx writes X-Forwarded-For from its own
  `$remote_addr` (`frontend/nginx.conf:13`); Express trusts one hop
  (`backend/src/server.js:12`). Auth limits are ten login requests per 15 minutes
  and five registration requests per hour (`backend/src/auth.js:45`). With a
  single additional ingress address and no real-IP configuration, all users are
  keyed to that proxy address. No deployed extra proxy was inspected.
- **Impact:** A few failed or successful attempts can exhaust the shared quota
  and deny other users login/registration. This is a topology-derived consequence
  of the supplied config, not a demonstrated attack on a running service.
- **Severity:** Medium security/availability defect for that production topology.
- **Recommended fix:** Recover client IP only from explicitly trusted ingress
  addresses and keep the backend unreachable except through the intended proxy.
  Verify distinct clients receive distinct limiter buckets and spoofed forwarded
  headers do not bypass limits.
- **Blocks deployment:** Conditional blocker before multi-user deployment behind
  an additional TLS proxy; not a blocker for direct local Nginx use.

### F6 — Search results do not identify their submitted term after filters change

- **Evidence:** Changing the term only updates term/department state
  (`frontend/src/components/SearchCourses.jsx:118`). Existing results remain;
  submitted filters are stored at `:100`, while the result heading/table at
  `:234`/`:242` display no term. Paging continues to use submitted filters at
  `:315`/`:323`.
- **Impact:** Selecting another term before submitting leaves old results under
  the new visible selection. Add still watches the original database section,
  which can surprise a user and differs from the form's visible term.
- **Severity:** Low UI ambiguity, established by source inspection; no browser
  reproduction in this audit.
- **Recommended fix:** Show the submitted term/filter summary above results, or
  clear results when term changes. Keep paging bound to submitted filters.
- **Blocks deployment:** No; useful before user acceptance testing.

### F7 — Legacy auth/production test entry points target ambient application state

- **Evidence:** `backend/test/auth.browser.cjs:5` defaults to localhost:8080;
  `:11` uses `docker compose exec`, `:55` restarts backend, and `:64` stops DB.
  `backend/test/production.cjs:5` loads the ambient DB and `:27` creates a user.
  Their cleanup does not make those operations read-only or isolated.
- **Impact:** Running these scripts as generic verification can mutate or
  interrupt the application stack. They are excluded from `npm test`, so the
  regular test command does not invoke this behavior.
- **Severity:** Medium operational safety defect.
- **Recommended fix:** Run them only through an explicitly test-owned stack and
  require its project/database identity. Prefer folding their checks into the
  disposable runner rather than keeping application-origin defaults.
- **Blocks deployment:** No direct runtime blocker; blocks treating these scripts
  as safe unattended checks against the existing stack.

### F8 — Checker logging and halt state lack bounded storage and health reporting

- **Evidence:** `src/checker.py:60` configures an ordinary file logger without
  rotation. `wait_for_cursor_repair` at `:306` deliberately remains alive while
  scheduling is halted. `compose.yaml:45` defines no checker healthcheck or logging
  limits. Backend/database healthchecks cannot detect a stalled checker.
- **Impact:** An apparently Up stack can have no polling, and persistent logs
  grow without an application-defined bound. The audit found a host checker log
  but could not attribute it to a current container version.
- **Severity:** Medium operational observability/storage gap.
- **Recommended fix:** Add bounded log rotation and a scheduler heartbeat or
  health signal that distinguishes waiting, working, and halted states. Keep
  corrupt-state preservation and manual recovery; avoid automatic destructive
  cursor repair.
- **Blocks deployment:** No local-demo blocker; address before unattended service.

### F9 — Some operational documentation is stale or contradictory

- **Evidence:** `docs/phase-2-sync.md:49` says browser Add/Remove do not write
  Watchlists; Phase 3 now does. That statement is historical but lacks an inline
  supersession note. `docs/operations.md:52` presents `docker compose exec checker
  manual_check`, then `:58` requires stopping that checker; exec cannot run in a
  stopped container. The later `compose run` alternative at `:62` is usable.
  `README.md:3` calls the project IT 610, while this audit targets IT 340.
- **Impact:** Operators can follow an invalid manual-check sequence or mistake
  historical phase behavior for current behavior.
- **Severity:** Low documentation defect.
- **Recommended fix:** Mark phase notes as historical, link their replacements,
  make the stopped-checker `compose run` sequence primary, and clarify the course
  labels. Preserve the no-concurrent-producer rule.
- **Blocks deployment:** No, but fix instructions before handoff.

## 5. Potential risks and unverified compatibility

These are distinct from confirmed failures on actual upstream data.

| Risk | Evidence and impact | Severity; recommendation; deployment effect |
|---|---|---|
| Real Banner formats and empty responses | Fixtures are synthetic (`docs/phase-1-sync.md:13`). Parser accepts `[]` but rejects header-only/empty-message markup (`src/njit_scraper.py:60`). A legitimate different format could prevent sync. | Medium compatibility risk. Obtain a small separately authorized response capture, sanitize it, and add fixtures. Blocks a claim of live verification. |
| Conflicting course titles can still cause HTTP 400 | The real parser accepts `conflicting_titles`; the real route returns `title/conflicting_title`, row 1. Subject mismatch and conflicting duplicate CRNs are also rejected by Express. A legitimate course with multiple per-section titles might hit this rule, but no such live payload was inspected. | Medium risk. Preserve strict validation until actual evidence supports an explicit catalog/section title policy. Do not suppress validation merely to remove 400s. |
| Historical DS / 202710 400 remains unexplained | Existing Phase 1 evidence records HTTP 400 without the rejected payload (`docs/phase-1-sync.md:7`). The sanitized local log scan found 20 lines containing HTTP 400, not necessarily 20 unique incidents. | Unknown historical cause. Use current structured diagnostics on an authorized future run. No claim that the original cause was fixed or reproduced. |
| Cross-term course title overwrite | Courses is unique by subject/number (`database/init/01-schema.sql:20`) and each term's sync overwrites that shared title (`backend/src/department-sync.js:67`). | Low/medium data-model risk if titles vary by term. Establish product semantics before adding term-specific metadata; not a reason to import the experimental schema wholesale. |
| Multiple producers or delayed old snapshots | No capture ordering/version check exists (`backend/src/department-sync.js:51`); backend tests explicitly demonstrate older snapshots can be reapplied (`backend/test/department-sync.test.cjs:201`). | Medium outside the documented singleton model. Keep one producer and discard failed submissions; ordering protection is needed before adding more. |
| Short pacing gap after restart or standalone calls | `next_banner_at` is process memory (`src/checker.py:177`); one-shot/manual paths do not use the scheduler gate (`:24`). The shared data lock does not cover those paths or another host. | Medium boundary risk. Do not run competing producers. If a five-second guarantee must span restarts, retain a safe cooldown/checkpoint or startup delay. No violation on the existing stack was observed. |
| Requests can exceed their nominal read timeout in total | Both HTTP clients use `(5,30)` timeouts, but Requests documents read timeout as inactivity, not a whole-download deadline. [Requests timeout documentation](https://requests.readthedocs.io/en/latest/user/quickstart/#timeouts). A slow continuing response can hold the gate. | Medium reliability risk, not an observed hang. Add total-duration/size bounds if required for an unattended service; do not describe 35 seconds as a guaranteed total maximum. |
| Docker may terminate active work before it drains | No `stop_grace_period` is configured. Compose's documented default is ten seconds; HTTP work can exceed it. [Compose stop grace documentation](https://docs.docker.com/reference/compose-file/services/#stop_grace_period). | Medium interruption risk. Set a deliberate grace period together with bounded operations. Cursor repetition/upserts reduce damage, but a killed or timed-out submission remains ambiguous. |
| Watchlist freshness and monitoring eligibility | UI refreshes on mount/tab change, not in the background (`Dashboard.jsx:47`). Targets outside configured terms/allowlist are filtered (`src/checker.py:180`), although saved watches still display. | Medium user-expectation risk. Display stale/inactive/unmonitored state and an explicit refresh action or modest background refresh. Does not justify on-demand Banner search. |
| Search pagination during concurrent updates | COUNT and page SELECT are separate statements (`backend/src/courses.js:74`). Concurrent ingestion can change totals/order between queries or pages. | Low consistency risk. Accept for this scale or use a read transaction if observed; do not introduce snapshot infrastructure preemptively. |
| Index/performance limits | Options scans DISTINCT joined catalog pairs; availability sorting computes a signed expression. No live EXPLAIN or row counts were available. Watchlists are unpaginated; watched batches reload all target memberships before every pair. | Low/medium scaling risk. Measure query plans and realistic batch duration first; no evidence currently warrants broad index or queue changes. |

## 6. Authentication and security assessment

### Controls reviewed

- Passwords use Argon2id with memoryCost 19456 KiB, timeCost 2, parallelism 1;
  verification uses a dummy hash for unknown accounts (`backend/src/auth.js:56`).
  Passwords are bounded to 15–128 code points on registration and <=128 on login.
- Login regenerates and explicitly saves the session before success (`:104`).
  Logout destroys it. The session store is MariaDB-backed, with a 30-minute
  rolling cookie and an eight-hour absolute authentication check (`:28`, `:63`).
- Production requires an exact HTTPS origin and uses a Secure, HttpOnly,
  SameSite=Lax, host-only `__Host-` cookie. Development cookies are deliberately
  non-Secure for loopback HTTP. Expired database sessions are periodically cleaned.
- Mutation requests require exact Origin, the custom request header, and JSON;
  watchlist mutations reuse those checks. No permissive CORS middleware exists.
- Login/register rate limits precede password hashing and session access.
- SQL values are parameterized. Search sort/order/column choices come from fixed
  maps, not raw user SQL. Watchlist ownership is derived from the authenticated
  session and included in list/delete SQL (`backend/src/watchlist.js:26`, `:55`).
- Checker authentication is separate from user sessions, runs before payload
  parsing/SQL, and compares SHA-256 token digests with timingSafeEqual
  (`backend/src/department-sync.js:118`). Missing token disables sync with 503.
- Public errors and validation diagnostics are sanitized. Python does not expose
  request URLs/tokens or upstream bodies in normal request errors. Express logs
  database error codes rather than SQL or payloads.

No critical or high-severity account takeover, SQL injection, or cross-user
watchlist access defect was established. This is a scoped source review with
blocked real HTTP/DB verification, not a penetration-test certification.

### Ranked security findings

| Rank | Finding | Evidence, action, and deployment relevance |
|---|---|---|
| Medium | Shared auth limiter bucket behind an extra proxy | F5. Configure trusted client-IP recovery before multi-user production ingress. |
| Medium | Production network isolation is weaker than the test topology | All four production services use Compose's default network (`compose.yaml:1`); tests separate API/database networks (`tests/integration/compose.yaml:75`). Checker receives no DB credential, but that is not network isolation. Add explicit deployment networks/firewall rules if checker/frontend must be unable to reach MariaDB. No direct DB access attempt was made. |
| Medium, conditional | Secret-file and build-context exclusions are incomplete | Root `.gitignore:24` ignores only `.env`; `git check-ignore` confirms `.env.production` and `checker.env` are not ignored, despite the latter being recommended in the VMware guide. Root `.dockerignore` is absent although checker build context is `.` (`compose.yaml:46`). Add exclusions with explicit template exceptions. Actual builder transfer/cache exposure was not inspected; Dockerfile COPY statements do not copy `.env` into the final checker image. |
| Low, conditional | Local `.env` mode is 0644 | Confirmed by filesystem metadata; no value is reproduced here. On a shared host, other users with directory traversal access may read it. Use owner-only permissions. No evidence of actual third-party access. |
| Low | Root checker, broad default container privileges, and flat trust | Checker Dockerfile has no USER (`Dockerfile:1`); backend explicitly runs as node (`backend/Dockerfile:7`). Consider a non-root checker with writable data ownership and restricted privileges before public deployment. No RCE was found. |

Frontend and database are published only on host loopback (8080 and 3307), and
backend has no published port (`compose.yaml:38`, `:81`). This is a good local
boundary; it does not implement cross-VM routing or TLS. Nginx overwrites supplied
forwarded headers, which helps prevent direct browser spoofing. `API_SCHEME=https`
only labels forwarded traffic; it does not encrypt it. Keep the plain HTTP
listener inaccessible except through the actual trusted TLS ingress.

Email verification is not currently enforced. It becomes a delivery-consent
requirement when notifications are implemented; it is not an existing email
abuse path because this application currently sends no automatic email.

## 7. Database and Docker findings

### Repository schema versus live schema

The live MariaDB volume could not be read. **Live table definitions, indexes,
foreign keys, row counts, null relationships, orphan counts, duplicates,
department timestamps, migration state, and experimental-column presence are all
unverified.** No values in the following table are presented as live observations.

| Table | Expected initialization structure/indexes |
|---|---|
| Users | Unsigned primary ID; unique username/email; password hash and verification flag (`database/init/01-schema.sql:4`). |
| Courses | Primary ID; unique `(subject, course_number)`; non-null title (`:14`). |
| Sections | Primary ID; unique `(term, crn)`; nullable course FK, availability and last-checked fields (`:24`). InnoDB supplies an FK-supporting course_id index. |
| DepartmentSyncs | Composite primary `(subject, term)` and nullable successful-sync timestamp (`:44`). |
| sessions | Binary-collated session primary key; expiry index; serialized data (`:53`). |
| Watchlists | Primary ID; unique `(user_id, section_id)`; FKs with user/section deletion cascades and supporting indexes (`:62`). |

Nullable course links are intentional legacy support, not necessarily orphaned
data. API search excludes unlinked Sections via INNER JOIN; watchlist listing uses
LEFT JOIN and a saved-label/subject fallback. Subject consistency between linked
Courses and Sections is maintained by ingestion but is not a cross-table database
constraint.

Migration `001-sessions.sql` is additive/repeatable. `02-course-catalog.sql:13`
adds course_id without an existence guard and is not safe to rerun blindly.
`03-cancelled-status.sql` expands the status enum. Existing volumes do not rerun
the initialization script on container startup. Do not infer applied migrations
from current source or run every migration as a repair procedure.

Experimental `snapshot_generation`, `last_refresh_status`, and
`last_refresh_source` are absent from this branch's initialization schema and
migrations. Current SQL uses explicit column lists, so additive columns with the
tested defaults can coexist. Compatibility tests at
`backend/test/department-sync.test.cjs:285` deliberately add and preserve them;
they do not prove the existing volume has that shape. Different non-null columns
without defaults could still make inserts fail. Do not drop or reset any existing
columns based on this audit.

### Minimal schema recommendations

No schema change is needed for the current watchlist CRUD or scheduler. First
inspect the live schema read-only. For the remaining work, use the smallest
explicit absence/active-state representation needed by F2, and a durable
notification outbox/event-delivery table for F1. Preserve Sections IDs and the
existing watchlist unique/FK constraints. Do not add an on-demand refresh
coordinator, broad snapshot history, or speculative indexes for Milestone 3.
Existing experimental columns should be assessed for compatibility before any
replacement is proposed.

### Deployment configuration and persistence

- **Confirmed local configuration blocker:** `.env` has no `CHECKER_TERMS`;
  `docker compose config --quiet` exits with the required-variable error from
  `compose.yaml:55`. The missing requirement can affect Compose configuration
  even when selecting other services. No configuration was changed.
- Local APP_ENV is development and the checker URL uses the internal HTTP
  default. Switching APP_ENV to production requires actual TLS ingress, matching
  origin/scheme, and a reachable HTTPS checker URL. Direct production HTTP was
  rejected in an in-process guard probe. This requirement is documented at
  `README.md:39`; it is a deployment prerequisite, not an unexpected auth bug.
- `./data:/app/data` (`compose.yaml:62`) correctly places the source-derived
  `/app/data/rotation.json` outside the checker container filesystem. Therefore
  **the configuration supports persistence across recreation** when the same host
  directory is retained. No `data/rotation.json` or checker lock existed in the
  host directory during this inspection. Actual existing-container mounts and
  deployed checker version could not be confirmed.
- MariaDB uses named `mariadb_data` and a read-only initialization mount. No
  volume was inspected, removed, or mounted by tests.
- DB health is required before backend startup, and backend health before
  frontend/checker startup. DB/backend have healthchecks; frontend/checker do
  not. Startup dependencies do not by themselves provide continuing service
  recovery or prove the checker is running the current source.
- All services use `restart: unless-stopped`. Corrupt cursor handling deliberately
  remains alive and needs separate health monitoring. Checker lacks a deliberate
  stop grace period; see the interruption risk above.
- Backend uses npm ci without dev dependencies and a non-root user. Frontend has
  a multi-stage build. Checker uses pinned direct Python dependencies, but its
  Ubuntu image and the Node/Nginx/MariaDB image tags float rather than using
  immutable digests. Record tested image versions before reproducible deployment.
- No Compose log rotation, resource limits, container image scan result, or
  deployment-level secret store is specified. Backend console logs are available
  to Docker; Python's main logs are in the mounted file, so `compose logs checker`
  alone does not show all scheduler activity.

### VMware differences

The ignored `data/references/IT 340/*_setup.txt` notes describe separate frontend,
backend, and database VMs with host services, private addresses, systemd, and
firewall rules. `docs/banner-smoke-test.md:193` adds checker-VM instructions.
These were inspected as planning artifacts; no VM was contacted. Reference PDFs
were not extracted because PDF tooling was unavailable; the milestone criteria
in this task were used directly.

| Compose behavior | VMware work still required |
|---|---|
| Docker service names `backend` and `db`; DNS resolver 127.0.0.11 | Use actual private DNS/IPs and host Nginx config. The container Nginx resolver cannot be copied unchanged to a host deployment. |
| Same-host loopback entry ports | Configure intended VM ingress, trusted TLS termination, firewall source restrictions, and exact APP_ORIGIN. |
| Checker on the same bridge | Provide backend HTTPS reachability and Banner egress; deny direct DB access; place one persistent data directory on the checker VM. |
| Compose restart/dependency management | Define systemd environment, startup ordering, restart policy, logs, and bounded graceful shutdown for host services. |
| Backend Docker image contains Node >=24 | Ensure the VM actually uses a supported Node version and reviewed package lockfile. |
| Branch working tree contains uncommitted Phase 3 | Setup note currently clones `multi-container`; deploy the explicitly reviewed complete source/image instead. |

The Terraform tree is a separate partial AWS deployment, not VMware automation:
`infrastructure/terraform/ecs.tf:16` defines only a frontend task;
`alb.tf:42` defines an HTTP listener; backend/database security groups reserve
future paths but do not create those runtimes. S3 public access is blocked and
encryption/versioning are configured, but that infrastructure does not deliver
the full authenticated Phase 3 application. No Terraform plan/apply was run.

## 8. Scheduler reliability assessment

| Requirement | Evidence and conclusion |
|---|---|
| Exact regular/watched wall-clock slots | `src/checker.py:73` defines regular `(1800,0)` and watched `(600,300)`. Epoch boundaries align with the documented New York minutes. Boundary/hour-rollover tests pass. Eligibility does not guarantee an exact network start while the gate is occupied. |
| At most two terms | `configuration()` at `:82` requires one/two distinct allowed six-digit strings; malformed, duplicate, Unicode-digit and oversized lists reject. |
| Department rotation | `run_slot` at `:236` chooses one subject and handles every configured term before cursor completion. Watched exclusions and expected failures still consume that department turn. |
| Watched exclusion/promotion/demotion | `watched_pairs` at `:180` deduplicates and filters actual Watchlists. `synchronize` at `:214` rechecks membership after pacing, excluding watched pairs from regular work and skipping demoted pairs from watched work. Newly watched pairs enter the next batch. |
| Persistent cursor | `RotationCursor.complete` at `:134` writes in the same directory, fsyncs file, atomically replaces, and fsyncs directory. Select is read-only. Passed restart/completion tests support this behavior; live mount unverified. |
| Crash behavior | Incomplete slots retain prior cursor; already committed terms can repeat at the next eligible regular slot. Upserts preserve identity. This is safe repetition, not exactly-once execution. A crash after replace/before directory fsync has uncertain durability, correctly documented. |
| Corrupt state | Startup rejects invalid JSON, unknown subjects, and invalid epoch slots, preserves the file and holds the singleton lock while idle. Tests pass. Future but structurally valid last_slot values are not corrected and can suppress rotation until time catches up. |
| Five-second spacing | One gate covers membership/fetch/parse/submit. A monotonic timestamp is set after Banner completion/failure at `:224`; later starts wait. Passed concurrent and fake-clock tests verify shared pacing within a process. |
| Fairness | Due/pending regular work has priority before new watched requests (`:185`, `:211`, `:217`). An active request finishes. Tests cover a large watched batch, delayed regular wake-up, lookup/pacing handoffs and concurrent callers. No deadlock or ordinary starvation was reproduced. |
| Duplicate prevention | Watched pairs use a set; batches do not overlap within a category; one gate serializes both. Repeated expected submissions remain idempotent. No cross-host singleton is provided. |
| Slow/overlapping intervals | Each loop finishes its active batch, then chooses a strictly future tick (`:290`). Missed ticks are skipped; no unbounded catch-up queue. Watched ticks have a one-second lateness window; regular ticks remain eligible for their interval. |
| Restart behavior | Between-tick startup waits for the next tick; no immediate catch-up import. Completed regular slots are not replayed from the cursor. SIGTERM cancels waiting work; Docker's stop deadline can still kill active work. |
| Clock changes | Epoch scheduling plus monotonic pacing handles DST and tested wall-time jumps without in-process replay. Backward corrections can postpone the next eligible tick; this is a tradeoff, not evidence of a deadlock. |
| Active terms change | Terms are read at startup. Existing environment changes need checker recreation; cursor continues by subject. A new term fills during rotation, potentially over 41 hours. Removed-term watches remain stored but are no longer polled. |
| Targets API unavailable | Expected errors prevent Banner fetch rather than guessing membership. A regular slot still completes/advances after failed membership checks; recovery for that non-watched subject can wait an entire rotation. |

With 82 subjects and two slots per hour, regular coverage needs 41 uninterrupted
hours. At most 164 configured watched pairs exist under the current filters;
163 minimum five-second gaps alone require 815 seconds, before other work.
The design cannot guarantee ten-minute refresh of every pair at that upper bound.
This is transparently documented and does not justify bypassing pacing.

Overall assessment: **sound single-process scheduling and crash repetition,
with explicit cadence/availability limitations and incomplete operational
monitoring**. Before unattended deployment, resolve F8 and choose the desired
outage recovery/grace-period policy. No scheduler rewrite is recommended.

## 9. Watchlist, frontend, and search assessment

### Persistent watchlists

The route design is sound: owner-scoped list/delete, ID-only insert, a database
unique key for duplicate additions, and foreign keys for user/section integrity.
Clients cannot select another user through request fields. Two users can watch
the same section independently. Removing one watch does not demote a pair still
watched by anyone else. Watchlists refer to Sections IDs, so an identical CRN in
another term remains a different entry.

Listing reads current stored Sections/Courses values rather than a saved copy of
status, preserves NULLs, and supports unlinked legacy rows. Refresh reads MariaDB
again. Sections are upserted without replacing IDs, preserving watch references.
Successful empty/missing-row snapshots do not delete user watches; F2 explains
the resulting accuracy gap. Real multi-user/persistence/constraint behavior is
covered by existing DB tests in source but was not executed here.

Dashboard uses an AbortController for list reads and a revision guard to prevent
old list responses from replacing a newer mutation (`Dashboard.jsx:20`). A ref
serializes mutations and disables controls while pending. Add 409 and delete
404 reconcile duplicate/already-removed membership. Other errors retain the
displayed list and permit retry. Initial load failure has an explicit retry
button and does not falsely show an empty successful list.

Displayed availability is an observation, not live state. A watchlist left open
does not refresh automatically. After Add, the dashboard first copies the search
row (`Dashboard.jsx:73`), which can predate the latest stored section update; the
next list read reconciles it. Both pages correctly use stored OPEN/CLOSED/
CANCELLED rather than deriving status from free seats. The watchlist shows last
checked time; search receives that timestamp but does not render it. Watches
outside active checker terms have no explicit unmonitored UI marker.

### Course search

`backend/src/courses.js` imports only Express and queries the injected DB pool.
It never calls a Python process, ingestion endpoint, or Banner. The React search
path only requests `/api/courses/options` and `/api/courses`. Therefore **normal
browser/API searches do not trigger Banner requests**. The standalone legacy
Python `search_courses` can trigger Banner and is outside this route graph.

Validation rejects unknown/duplicate/non-string query fields, malformed terms,
invalid statuses/sort/order, excessive limits/offsets, and inconsistent full
course codes versus selected subjects. Search is course-number prefix matching,
not arbitrary course-title text search. Values are bound parameters; sort columns
are allowlisted. Availability subtraction is signed and places NULL availability
last. Ordering includes section ID for deterministic ties. Numeric course numbers
are sorted as stored strings, which should be accepted or specified explicitly
if a numeric ordering expectation emerges.

Pagination defaults to 50, caps at 100, and returns a separate total count.
Options contain only joined local term/subject pairs, sorted by newest term and
subject; they are not the 82-code scheduler allowlist or only the two active
checker terms. An unsynchronized or unlinked catalog cannot be searched through
these options. Old terms and omitted sections remain available, as documented.
Existing `(term,crn)`, `(subject,course_number)`, and FK indexes support the basic
access paths; actual effectiveness requires live EXPLAIN/row counts.

React aborts superseded search requests, guards stale responses after JSON
parsing, keeps submitted pagination filters, supplies loading/empty/error states,
and retries catalog metadata failures. The filter/result term ambiguity is F6.

### Navigation, layout, accessibility, and browser limits

Protected routes wait for session lookup; dashboard/account require a user.
Login/register have associated labels, password visibility button names,
autocomplete attributes, pending controls and alert messages. Navigation has a
label and current-page markers. Dashboard removal buttons identify the course,
section and term. Tables scroll horizontally at narrow widths, and search inputs
adapt from one to three columns.

Remaining accessibility improvements are modest: dashboard tab buttons expose no
selected/tab-panel relationship; tables have no captions; search result Add
buttons all have the same accessible name instead of identifying their section.
These are low-severity source findings, not a full accessibility conformance
assessment. Keyboard, contrast, focus behavior, mobile screenshots, runtime
console warnings, and request traces were not independently browser-verified in
this audit. The existing browser script records runtime exceptions at
`tests/integration/course_search_browser.mjs:44`; it does not comprehensively
collect all console warnings or perform an accessibility scan.

## 10. IT 340 Milestone 3 readiness

| Deliverable | Classification | Remaining evidence/work |
|---|---|---|
| NJIT Banner API integration for course availability | **Implemented but not live-verified** | Offline parsing, validation, scheduler and ingestion control flow are present. Run disposable real DB/proxy integration and then a separately authorized small live compatibility check; resolve availability omissions. |
| Automatic email notifications for watched sections | **Not implemented** | Backend change events, durable delivery state/retries, sender configuration, recipient consent/verification, and a demonstrated watched-opening email are missing. |
| Course search, filtering, and sorting through API calls | **Implemented but not live-verified** | Source, lint/build and Python-related checks pass; current environment blocked real HTTP/DB/browser execution. Existing fixture integration/browser scripts provide the right verification path. Search remains database-only. |

Milestone 3 cannot be marked complete from the historical test counts in phase
documents. The shortest path is completing backend-owned email delivery and
current end-to-end verification, while addressing the small deployment and data
accuracy issues that would undermine the demonstration. An experimental
on-demand refresh architecture or broad schema redesign is unnecessary.

## 11. Recommended fixes in priority order

| Priority | Action | Reason |
|---|---|---|
| P0 | Implement watched-section email events and durable delivery; verify recipient ownership before sending | Only completely absent Milestone 3 deliverable (F1). |
| P0 | Define and implement absent-section availability semantics without deleting watches/IDs | Avoid obsolete OPEN results and misleading notifications (F2). |
| P0 deployment gate | Set deliberate CHECKER_TERMS; assemble the complete reviewed Phase 3 source; select actual HTTPS origin/checker URL | Current local Compose validation fails and HEAD omits Phase 3 files. These require later authorized configuration/release work. |
| P1 | Fix auth response ordering and clear stale errors | Reproduced login/recovery failures (F3). |
| P1 | Align ingestion proxy limits and trusted client-IP handling | Production-path ingestion and multi-user auth reliability (F4/F5). |
| P1 verification | Run isolated MariaDB tests, full fixture pipeline, and Chrome tests; inspect existing DB read-only | Essential evidence currently blocked. Never use the application DB as a test DB. |
| P1 operations | Add checker health/heartbeat, bounded logs, and deliberate shutdown grace; verify actual mount/version | Unattended scheduler reliability (F8). |
| P2 | Improve secret ignores/build exclusions, local file permissions and deployment network segmentation | Concrete gaps in the current security boundaries. |
| P2 | Label submitted search term, stale/unmonitored watches, and current-data timestamps | Improve user interpretation of stored observations. |
| P2 | Isolate legacy test scripts, correct operational docs, and remove unused mock/legacy paths after review | Reduce handoff mistakes and maintenance overhead. |

## 12. Minimal roadmap

1. **Confirm the deployment baseline.** Preserve the existing DB and cursor.
   Read live schema/counts/orphans/experimental columns and identify deployed
   images/mounts when access is available. Choose the two active terms and the
   exact reviewed source/image to release. No merge of the experimental branch.
2. **Make stored availability and auth behavior dependable.** Address F2/F3,
   align proxy body limits/client identity, and add focused regression tests.
   Reuse existing constraints and stable IDs.
3. **Complete one email delivery path.** Define the opening trigger (for example,
   stored non-OPEN to OPEN), create durable backend events in the same transaction
   as availability updates, fan out to current consenting watchers, and deliver
   with retries/duplicate protection. Repeat identical snapshots must not resend
   the same event. Test two users, failures/retries, disappearance, and reappearance.
4. **Verify in disposable infrastructure.** Run all 18 Express cases against a
   fresh disposable MariaDB, the full 15-case fixture pipeline with browser mode,
   production proxy/cookie checks, and large-body ingestion through Nginx.
   Historical counts are targets to reproduce, not substitutes for execution.
5. **Authorize a small live/deployment acceptance pass separately.** Check real
   Banner nonempty/empty formats, VM TLS/routing/firewall behavior, cursor
   persistence across controlled recreation, and an opening email to a consenting
   test recipient. Then demonstrate search/filter/sort and persisted watchlists.

## 13. Operations outside this audit's authority or environment

No approval requests were sent while the user was away. No automatic approval
review was invoked or rejected; ordinary sandbox restrictions prevented Docker
socket access and loopback listening. These were documented and not retried with
escalated permissions.

The following need a later authorized session or suitable isolated environment:

- Docker metadata/log/volume inspection and read-only MariaDB inspection remain
  authorized in principle by the task but **blocked by environment permissions**.
  Access alone would not authorize application DB writes.
- Disposable DB/integration/browser runs require a Docker-capable environment
  and loopback listener permission. They are already within the requested test
  scope, but were unavailable here; no application container should be reused.
- Any live Banner request, outbound test email/webhook, VM connection/deployment,
  existing-container restart/recreation, configuration/secret change, migration,
  existing DB write, or cursor repair requires separate authorization because the
  task explicitly excludes those operations.
- Fixing application code, staging/committing, changing branches, or publishing a
  release is outside this review. This audit ends with the report.

### Read-only database follow-up checklist

When the existing database can be accessed safely, use a read-only account and
inspect these items without returning password hashes, session contents, or
personal account data:

1. SHOW CREATE TABLE for the six expected tables; information_schema columns,
   statistics, and key_column_usage for exact live definitions.
2. Exact COUNT(*) per table; count Sections with NULL course_id separately from
   genuinely dangling course references.
3. Count Watchlists with missing Users/Sections and linked Sections whose subject
   differs from their Course subject. Do not assume uniqueness/FKs are present
   merely because the current initialization script declares them.
4. GROUP BY/HAVING duplicate checks for term/CRN, subject/course number, and
   user/section watch pairs; compare constraints and collation behavior.
5. DepartmentSyncs timestamps and per-department/term section counts, including
   NULL/old last_checked_at values; distinguish a successful department timestamp
   from observation of every retained row.
6. Presence, types, nullability, and defaults of experimental snapshot/refresh
   columns; compare with current explicit-column inserts and historical migration
   intent before recommending any migration.
7. EXPLAIN representative local search/options/watchlist/target queries at actual
   row counts. Add indexes only for demonstrated access-path problems.

No live schema remediation or data cleanup is implied by this checklist.
