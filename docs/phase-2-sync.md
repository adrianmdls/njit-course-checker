# Phase 2: round-robin synchronization

The checker now has two independent scheduling threads inside its existing
process. There are no new services, dependencies, queues, database tables or
migrations. Phase 1 parsing and Express transactional upserts remain intact.

## Configuration

Set explicit terms in `.env` before a future deployment:

```dotenv
CHECKER_TERMS='["202690","202710"]'
BANNER_REQUEST_DELAY=5
```

These are examples, not automatically selected terms. `CHECKER_TERMS` must be a
JSON array of one or two distinct six-digit strings ending in 10, 50, 90 or 95.
Missing, empty, malformed and duplicate term lists fail startup. No automatic
term discovery occurs. `BANNER_REQUEST_DELAY` must be finite and at least 5
seconds; larger decimal values are accepted. Compose passes both settings to
the checker. `CHECK_INTERVAL` is retired and removed from the image defaults.

The existing URL/token settings still apply. No SQL credentials are required.
The department list is read from `src/departments.json` at startup. Its Phase 1
verification limitations remain documented in `phase-1-sync.md`.

## Schedule and category membership

| Loop | Wall-clock minutes each hour | Work |
|---|---|---|
| Regular | :00, :30 | One next NJIT department, across configured terms, excluding watched pairs. |
| Watched | :05, :15, :25, :35, :45, :55 | Unique currently watched NJIT subject/term pairs within configured terms. |

There is no special initial import. Starting between ticks waits for the next
scheduled tick. A new term populates naturally when each department reaches its
normal regular slot. Eighty-two half-hour slots take approximately 41 hours,
provided the checker stays running and slots are not missed. The cursor advances
once per executed regular slot even if all configured pairs are watched or a
request fails. Missed regular slots do not consume departments.

Priority membership comes from the existing authenticated
`GET /api/internal/sync/targets?watched_only=true` endpoint. Its SQL joins
Watchlists to Sections, so duplicate watches collapse to a single pair. The
checker additionally deduplicates, sorts, and filters by allowlist and configured
terms. Watches for other terms remain stored but are not scheduled.

The endpoint without a query retains its Watchlists-plus-explicit-targets
behavior for existing callers. `CHECKER_MONITORING_TARGETS` does not grant
scheduled priority without an actual database watch. The browser's demo Add and
Remove controls still do not write Watchlists; no watchlist CRUD was added.

Before each fetch, after waiting for the shared lock and pacing, the checker
retrieves current watched membership again. Regular work skips a newly watched
pair; watched work skips a demoted pair. Newly promoted pairs enter the next
watched batch. Demoted pairs return to their department's next regular turn;
there is no immediate catch-up import. A targets API failure skips affected work
rather than guessing membership or starting an unverified upstream request.

## Serialization, pacing and slow work

One shared condition gate covers the membership recheck, Banner fetch, strict parsing and
synchronous Express submission. This prevents concurrent Banner requests and
also prevents two fetch/submit instances of any target from overlapping inside
the checker. Each loop processes its batch synchronously; another batch of that
same category cannot start until the current one finishes.

The minimum Banner pause is measured **from request completion or failure to the
next request start**, using a monotonic clock. Parsing and backend submission may
already consume some or all of that pause. A failed Banner request is not retried
inside the batch. Invalid snapshots never submit; validated empty arrays submit
normally and remain nondestructive. A failed backend submission is discarded,
with the next scheduled attempt fetching fresh data.

Active batches finish, including their remaining targets. On completion, their
loop selects the next strictly future tick; it never queues ticks that happened
while busy. This avoids repeatedly abandoning the last watched targets during
slow batches. Watched ticks allow subsecond wake-up latency and skip stale ticks. An already
published regular slot stays eligible until the following regular tick even if
its thread wakes late: watched requests cannot bypass that due slot. Fully
missed regular intervals are skipped. Waits recheck wall time at most
every 30 seconds so suspension and wall-clock corrections are noticed. Tick
identities use Unix epochs: DST repeated hours do not replay the same epoch.
New York's :00/:30 and :05/... boundaries align with these epoch schedules.

A regular-pending flag and published due timestamp give regular work priority
before any new watched request. The timestamp closes the gap where the regular
thread has not yet woken at :00/:30. Watched work checks again after pacing and
membership lookup and yields the gate if regular work became due. An active
watched fetch/parse/submit can finish; then both configured regular terms are
handled before the watched batch continues. This does not rely on lock fairness,
and does not preempt an HTTP request or database transaction already underway.
Scheduled time denotes eligibility, not an exact request start while another
request is active. Ten minutes is a target cadence: 164 watched pairs require more than
13 minutes from the minimum gaps alone, before network, parsing or database
latency. Such a batch completes and skips intervening ticks. No concurrency or
aggressive retry bypasses the pacing rule. A 41-hour rotation is similarly a
normal-operation target, not a guarantee through outages or suspension.

SIGTERM and Ctrl+C stop waiting work. A fetch/submission already underway can
finish; both loops are joined before releasing the process lock.

## Rotation persistence

`data/rotation.json` uses the existing persistent checker data mount, not MariaDB:

```json
{"next_subject":"AD","last_slot":1794916800}
```

The cursor stores the next subject by code and the last **completed** regular
epoch. Selecting a department is read-only. Only after every configured term has
been attempted (or excluded because watched) does completion write a temporary
file in the same directory, flush/fsync it, atomically replace the cursor, and
fsync the directory. An individual fetch, parser, membership or submission
failure counts as an attempt and does not block rotation indefinitely.

A crash, shutdown or unexpected interruption before department completion leaves
the previous cursor intact. The same department is retried at the next eligible
regular slot; terms that already committed can be submitted again safely through
the existing idempotent upserts, retaining section IDs and Watchlists. A crash
after all attempts but before the cursor write has the same safe retry behavior.
Failed completion persistence stops scheduling; keep the prior cursor/backup.
An atomic replace followed by a directory-fsync error has an uncertain durability
outcome and needs operator inspection, as with other filesystem failures.

Keep the data directory across restarts; removing it loses progress. The JSON
format is unchanged from the previous implementation, but old `last_slot` values
were reservations. The new code cannot determine whether such a historical slot
finished; it preserves the stored next subject rather than guessing or silently
rewinding it. There is no automatic cursor reset or migration.

## Cursor recovery

An unreadable/invalid cursor or unknown next subject raises a dedicated state
error. Before starting scheduling threads, the checker logs **Scheduler halted**
with this recovery path and retains the process lock. It then stays alive without
Banner or targets requests, waiting for SIGTERM/Ctrl+C. This avoids the repeated
exits/restarts caused by Compose's `restart: unless-stopped`. The invalid file is
never overwritten, renamed or deleted automatically. A halted container can
still appear `Up`; inspect `data/checker.log`. There is no automatic reload after
editing the file.

Recovery is an explicit operator action, not something performed by tests or
this implementation run:

1. Stop only the checker (`docker compose stop checker`) before editing state.
2. Copy `data/rotation.json` to a uniquely named diagnostic backup, preserving
   its exact contents; inspect the log and fix any storage/permissions problem.
   Do not remove the invalid file without preserving that evidence first.
3. Prefer restoring a verified cursor backup. Otherwise explicitly choose the
   department to retry from `src/departments.json` and reconstruct valid JSON in
   a separate file in `data/`. `next_subject` must be a current allowlist code;
   `last_slot` must be a nonnegative integer Unix timestamp divisible by 1800,
   representing a known completed slot. If the completion time is unknown, an
   operator may deliberately use `0` as a conservative older checkpoint with
   their chosen subject. This is a manual recovery choice, not an automatic
   reset or a claimed historical completion time.
4. Validate that JSON and its selected subject, flush it to disk, then atomically
   rename the replacement over `data/rotation.json`. Keep the diagnostic backup.
5. Start only the checker (`docker compose start checker`) and verify the halt
   no longer appears and regular processing resumes at its next scheduled tick.
   Do not reset MariaDB or rerun migrations. Repeated ingestion is safe, although
   an old backup can cause some department work to repeat.

`data/checker.lock` is held through a POSIX advisory file lock for the lifetime
of the checker. A second checker sharing that directory fails startup. Stale
lock-file contents do not hold a lock after process exit. Separate directories
or hosts are not protected by this lock: deploy only one checker. Standalone
`manual_check`, `department_sync` and legacy Python search commands are outside
this process's serialization mechanism and must not run concurrently with it.

## Files and deterministic validation

- `src/checker.py`: term/delay validation, persistent cursor, two loops and shared synchronization lock.
- `src/checker_api.py`: optional watched-only query on the existing endpoint.
- `backend/src/department-sync.js`: backwards-compatible watched-only target selection and query validation.
- `compose.yaml`, `.env.example`, `Dockerfile`: explicit terms and pacing; retired interval default removed.
- `tests/test_scheduled_checker.py`: fake-clock boundaries, term validation, two terms, promotion/demotion, pacing, actual thread contention, persistence, interrupted-slot retry, regular priority handoffs, corrupt-state halt, startup singleton, clock jumps, slow/failed work, empty/malformed responses and shutdown.
- `tests/test_checker.py`, `tests/test_department_sync.py`: retained one-shot behavior and watched-only client coverage.
- `backend/test/department-sync.test.cjs`: watched-only versus explicit targets and invalid/duplicate query rejection.
- `tests/integration/checker_probe.py`, `tests/integration/test_pipeline.py`: fake-clock scheduled slots through real Express/MariaDB, two terms, regular exclusion, actual watched ingestion, and Compose configuration.
- `README.md`, `backend/README.md`, `docs/operations.md`, `docs/banner-smoke-test.md`, this file: current configuration, behavior and limits.

No changes were made to course search, database schema, migrations, Watchlist
CRUD, notifications, inactive-section filtering, or snapshot-generation logic.
No live Banner requests were used. Tests only use mocks/fixtures and disposable
MariaDB storage; the existing volume and running application containers were
not changed. Files were not staged or committed.

Final verification:

- `.venv/bin/python -B -m unittest discover -s tests -p 'test_*.py'`: 55 passed (original Phase 2 run).
- Express with a newly created tmpfs MariaDB container on a random loopback port:
  12 passed, no skips. The initial run without a disposable database skipped two
  database cases; both passed in the full run.
- `python3 -B tests/integration/test_pipeline.py`: 15 passed against the runner's
  disposable stack, including the two new scheduled-slot pipeline tests.
- `git diff --check`: passed.
- Optional browser mode was not run; frontend behavior is unchanged.
- Temporary database containers and integration stacks were removed after tests.
  The current branch remains `feature/scheduled-course-sync`; the preserved
  `feature/persistent-watchlists` ref remains `599cce9`.

Stop for review here. Applying configuration or recreating the existing stack is
not part of this implementation run.

## Reliability follow-up

This follow-up changes only `src/checker.py`, `tests/test_scheduled_checker.py`,
`README.md`, `docs/operations.md` and this document:

- Cursor selection no longer writes state. Atomic completion happens after all
  configured terms are handled; expected per-term failures do not stop rotation.
- The shared condition gate gives published due regular work priority, including
  before the regular thread wakes and after watched pacing/membership checks.
  Already-running watched fetch/parse/submit work finishes without preemption.
- Invalid cursor startup enters a logged idle halt while preserving the file and
  process lock, with an explicit operator recovery procedure above.
- Deterministic tests cover completion timing, mid-slot crashes, initial-slot
  crashes, term failures, failed persistence, graceful interruption, due regular
  work ahead of a 16-target watched batch, in-flight watched completion, pacing
  during both handoffs, and corrupt-state preservation/halt.

Follow-up results: **65 Python tests, 12 Express tests with disposable MariaDB,
and 15 disposable integration tests passed**, with no failures or skips.
`git diff --check` passed. Optional browser mode was not run. No live Banner
requests, writes to the existing MariaDB volume, application-container restarts,
branch switches, staging or commits were performed. Test-only stacks and the
standalone temporary database were cleaned up.

Remaining limits: active HTTP/database work is not preempted; network and storage
failures can still delay work. Fully missed scheduling intervals remain skipped,
and heavy watched batches can exceed their target ten-minute cadence. Crash
recovery provides idempotent repetition rather than exactly-once synchronization.
A halted corrupt-state container is intentionally still alive and requires log
inspection plus manual recovery; no health endpoint or automatic repair was added.
