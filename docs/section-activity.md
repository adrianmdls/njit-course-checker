# Section activity and conservative preservation (F1)

`Sections.is_active` is retained activity state, separate from the last explicit
Banner status. Explicit observations set it true. Absence from an accepted
response no longer changes it: structural validity does not prove upstream
completeness. Historical activity and status may become stale.

## Ingestion and presentation

- A nonempty response upserts only observed sections as active. All writes and
  DepartmentSyncs completion share the existing transaction and department lock.
- Omission preserves every section field exactly: IDs/CRNs, activity, status,
  enrollment, course links and last-observed timestamps. Watch relationships also
  remain unchanged. Both omitted active and inactive rows retain their flags.
- Previously inactive observed sections keep their IDs, become active, and receive
  current observed fields/timestamps. Their reactivation does not increment `status_changes`.
  New sections also establish a baseline. Changes on already active sections
  retain the existing status-change counting behavior.
- Successful empty snapshots preserve **all** existing section fields/activity,
  including already inactive rows. They still record department completion.
  Real Banner empty-response semantics remain unverified.
- Failed fetching/parsing/validation submits no accepted observations. SQL failures
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

The same explicit-observation requirement applies to OPEN-to-CLOSED. Neither
direction is notification-ready: this safeguard does not distinguish complete
from incomplete responses. Do not use department completion or aggregate counts
as completeness evidence. `DepartmentSyncs.last_synced_at` still records accepted
work, including empty responses; it does not refresh omitted sections' timestamps.
Existing false/inactive historical flags are not repaired speculatively. Only a
new explicit observation reactivates such a section. No new schema or migration,
generation tracking, or locally asserted completeness flag is introduced.

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
   explicit observations establish activity without a forced Banner import.

Fresh databases receive the column through `database/init/01-schema.sql` and do
not need this migration. Existing volumes do not rerun initialization automatically.
Do not rerun unrelated migrations or reset a volume.

The obsolete experimental `snapshot_generation` columns can be removed with the
separate [generation cleanup migration](snapshot-generation-cleanup.md). They are
not used by F2. Optional `last_refresh_status` and `last_refresh_source` columns
remain unused and untouched; retain them. Existing non-null columns without
suitable defaults or custom triggers still require schema-specific review.

For an application rollback, retain the additive column and its data. Older code
ignores activity and restores the previous stale-search behavior. Dropping the
column discards activity information and requires a separate reviewed operation.

## Verification

Current F1 regressions include structurally valid responses omitting whole rows,
course blocks, and response-array items. The Python parser tests show why those
responses pass structural checks. Disposable pipeline tests then assert exact
omitted-row/watch preservation, historical timestamps and mixed activity states,
observed updates/reactivation, stable identities and idempotent retries. Existing
validation, locks, empty-response, rollback and migration regressions remain.

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

F1 verification on November 18, 2026: **73 Python unit tests, 31 backend tests
against a fresh networkless tmpfs MariaDB server, and 26 frontend component tests
passed**. The full disposable pipeline passed **18 tests**, including both Chrome
scenarios. The strengthened partial-response regression also passed separately
with all six combinations of omission shape and prior active/inactive state.
Frontend lint, production image builds, Python/JavaScript syntax, fixture JSON
and whitespace checks passed. All test-owned database containers/stacks were
removed. No application database, application-container restart, live Banner
request, schema/migration edit, generation tracking or notification implementation
was involved. The untracked November 18 audit report was preserved unchanged.

### Historical F2 verification (before the F1 preservation safeguard)

The results and omission/deactivation descriptions below record the earlier F2
implementation; the current F1 policy above supersedes that behavior.

Initial verification on November 18, 2026: six socket-free backend tests passed; the new
MariaDB case skipped. All ten frontend component tests and 65 Python tests passed;
frontend lint/build, JavaScript syntax checks and `git diff --check` passed. The
full backend run reported seven passes, 14 loopback `listen EPERM` failures, and
four disposable-database skips. Docker socket access was denied, so no disposable
MariaDB/pipeline/browser stack could run. No existing database, container, parser,
scheduler or pacing configuration was changed, and no live Banner call was made.

### Disposable pipeline follow-up

This follow-up records the earlier F2 behavior and results. Use the
[Banner smoke-test guide](banner-smoke-test.md) for current test commands.

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
full F2 lifecycle. Both real Chrome scenarios also passed.
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
nonempty response that silently omits a course, page, or section can still pass.
F1 prevents absence-driven deactivation by preserving missing rows. It does not
prove completeness or detect legitimate removals. An omitted active section can
remain searchable with an old OPEN/CLOSED/CANCELLED status; consult its actual
last-observed time. Verify the real response contract and pagination before
restoring absence-based reconciliation or enabling snapshot-derived notifications.
