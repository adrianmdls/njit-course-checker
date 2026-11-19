# Section activity (F2)

`Sections.is_active` records presence in the latest accepted **nonempty** complete
department/term snapshot. It is separate from the last explicit Banner status.
Disappearance is not an official cancellation.

## Ingestion and presentation

- A nonempty snapshot upserts observed sections as active and marks omitted CRNs
  inactive for that exact subject/term. All writes and DepartmentSyncs completion
  share the existing transaction and department lock.
- Omission changes only `is_active`: IDs, watches, stored status, enrollment,
  course links, and last observation timestamps survive.
- Returning sections keep their IDs, become active, and receive current observed
  fields/timestamps. Their reactivation does not increment `status_changes`.
  New sections also establish a baseline. Changes on already active sections
  retain the existing status-change counting behavior.
- Successful empty snapshots preserve **all** existing section fields/activity,
  including already inactive rows. They still record department completion.
  This exception remains until real Banner empty-response semantics are verified.
- Failed fetching/parsing/validation submits no reconciled data. SQL failures
  roll back activity, observed values, and department completion together.
- Search, result counts, and catalog options include only active sections.
  Both search and watchlist APIs return a JSON boolean `is_active`.
- Watchlists retain inactive sections and show Unavailable, historical last-seen
  time, and dashes for current enrollment/capacity. Removal remains available.
  Inactive watches continue contributing monitoring targets so reappearance can
  be detected. The scheduler, pacing, parser, and request protocol are unchanged.

No email delivery is implemented. A future CLOSED-to-OPEN event must require an
already active prior observation with explicit CLOSED status followed by explicit
OPEN status. Disappearance/reappearance alone is not such an event; aggregate
`status_changes` is not a substitute for per-section notification eligibility.

## Existing-volume migration (manual; not applied by this change)

1. Back up the database and inspect its actual schema using the normal secure
   administrative connection. Do not assume it matches initialization SQL:

   ```sql
   SHOW CREATE TABLE Sections;
   SHOW CREATE TABLE DepartmentSyncs;
   SHOW COLUMNS FROM Sections LIKE 'is_active';
   ```

   If `is_active` exists, verify a compatible boolean/TINYINT definition,
   NOT NULL, default 1, and valid 0/1 data. Skip the ADD only if compatible;
   investigate differences rather than overwriting or blindly skipping them.
   Also inspect optional columns/defaults and triggers that could affect writes.

2. If the column is absent, apply **only**
   `database/migrations/04-section-activity.sql` to `njit_course_checker` once,
   before deploying the updated backend. For example, with an existing private
   MariaDB client configuration (substitute its real path):

   ```sh
   mariadb --defaults-extra-file=/secure/client.cnf njit_course_checker < database/migrations/04-section-activity.sql
   ```

   The migration adds `is_active BOOLEAN NOT NULL DEFAULT TRUE`; it is not
   repeatable. DDL is a separate deployment step, not part of ingestion's rollback
   transaction. Coordinate deployment so old/new ingestion writers are not mixed.

3. Verify the column/default and row/watch counts. Existing rows initially remain
   active; historical inactivity is not inferred during migration. Normal future
   nonempty synchronizations establish activity without a forced Banner import.

Fresh databases receive the column through `database/init/01-schema.sql` and do
not need this migration. Existing volumes do not rerun initialization automatically.
Do not rerun unrelated migrations or reset a volume.

Optional experimental `snapshot_generation`, `last_refresh_status`, and
`last_refresh_source` columns remain unused and untouched. Explicit-column
statements preserve them; existing non-null columns without suitable defaults or
custom triggers still require schema-specific review. Do not drop these columns.

For an application rollback, retain the additive column and its data. Older code
ignores activity and restores the previous stale-search behavior. Dropping the
column discards activity information and requires a separate reviewed operation.

## Verification

- `node --test backend/test/section-activity.test.cjs` runs socket-free handler/SQL
  checks. They verify control flow and query construction, not real database
  transactions or constraints.
- With `TEST_DB_PORT` explicitly set to a **disposable** MariaDB server using the
  documented test credentials, the same suite creates a random schema, tests the
  migration over legacy rows plus experimental columns, omission, reactivation,
  empty preservation, rollback, watch preservation, and active-only search/options.
  It removes only that test-owned schema. Never select an application DB port.
- `npm test --prefix frontend` covers the Unavailable badge, last-seen time,
  hidden current counts, and removal using the existing component harness.
- Run the full backend, Python, lint/build and disposable pipeline/browser suites
  where their environment requirements are available.

Initial verification on November 18, 2026: six socket-free backend tests passed; the new
MariaDB case skipped. All ten frontend component tests and 65 Python tests passed;
frontend lint/build, JavaScript syntax checks and `git diff --check` passed. The
full backend run reported seven passes, 14 loopback `listen EPERM` failures, and
four disposable-database skips. Docker socket access was denied, so no disposable
MariaDB/pipeline/browser stack could run. No existing database, container, parser,
scheduler or pacing configuration was changed, and no live Banner call was made.

### Disposable pipeline follow-up

The existing MariaDB regression already covers the legacy-schema migration,
experimental columns, scoped omission, stable IDs/watches, reactivation, transition
counting, empty preservation, rollback, and search/options filtering. The pipeline
now reuses that test inside its disposable backend container, connecting only to
the test stack's `db` service and creating its own random schema. Read-only test
and database-script mounts are confined to `tests/integration/compose.yaml`.

One additional lifecycle case exercises actual Python parsing/submission and
authenticated HTTP search/watchlist reads through Nginx. It checks disappearance,
retained IDs/status/timestamps/watches, inactive-only monitoring targets,
reactivation without a transition, and subsequent continuously active transitions.
Existing empty and failure tests now cover mixed activity states and a rollback
after attempted omission updates. A runtime schema assertion checks the fresh
database column type, nullability, and default before running the reused tests.

The suite now passes **all 17 integration cases** against disposable MariaDB,
including migration from the previous schema with experimental columns and the
full F2 lifecycle. Both real Chrome scenarios also passed. From the repository
root, run:

```sh
python -B -m pytest tests/integration/test_pipeline.py -v
```

This command owns its random Compose project/tmpfs database and runs the migration
case automatically; do not supply an application database. Optional existing
browser checks can be enabled with `RUN_BROWSER_TESTS=1` when Chrome is available.
Current follow-up checks passed: 72 Python unit tests (plus 61 subtests), all 30
backend tests on a fresh disposable MariaDB server, 15 frontend tests, frontend
lint/build, and `git diff --check`. Database suites ran serially to avoid sharing
server-wide advisory lock names across test schemas. Chrome verified inactive
watchlist rendering and search exclusion; API tests verified real reconciliation,
reactivation, transition counts, and transactional rollback. The existing production
authentication smoke script also passed inside the disposable integration stack.
No application database, persistent volume, scheduler state, or existing
application container was changed, and no live Banner request was made.

## Remaining completeness risk

The parser rejects recognized malformed/truncated responses, but structural
validity does not establish upstream completeness. A syntactically valid
nonempty response that silently omits a course, page, or section can pass and
incorrectly deactivate absent records. This change does not introduce a new
proof-of-completeness mechanism. Verify the real response contract and pagination
behavior before relying on absence as authoritative. A later complete nonempty
snapshot reactivates returning rows without losing IDs/watches or counting their
reappearance as a transition. Empty responses deliberately cannot clear this or
other stale activity states until their semantics are verified.
