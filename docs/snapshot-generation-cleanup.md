# Obsolete snapshot generation cleanup

The repository audit found no production reader or writer of
`Sections.snapshot_generation` or `DepartmentSyncs.snapshot_generation` in
Python, Express, React, or SQL. Ingestion uses transactions and department locks;
F2 reconciles omitted sections using `is_active` and supplied CRNs. Search,
watchlists, monitoring targets, and transition counts do not depend on generations.
The fresh initialization schema already excludes both columns. No historical
migration introduces them; existing migration files remain unchanged. Older audit
and phase notes are retained as historical records.

The remaining executable references deliberately construct legacy schemas and test
migration 05. Ordinary ingestion tests no longer install or assert generation
metadata. Other experimental refresh-status/source columns are outside this cleanup.

## Manual migration of an existing volume

Migration: `database/migrations/05-remove-snapshot-generation.sql`.
This change does not apply it to any application database.

Before applying it through the normal administrative process:

1. Back up the database, including schema and any generation values worth retaining.
2. Inspect actual `SHOW CREATE TABLE Sections` and `SHOW CREATE TABLE DepartmentSyncs`
   output. Inspect custom indexes, triggers, views, stored routines, scheduled DB
   events, and external consumers for dependencies. Those cannot be established
   from this repository audit; resolve any dependency before running the migration.
3. Verify that the deployed ingestion code uses `is_active` and that the F2 migration
   is already applied. Record row counts, IDs, watches, activity states, and timestamps.
4. Apply only this migration, using an existing secure MariaDB client configuration:

   ```sh
   mariadb --defaults-extra-file=/secure/client.cnf njit_course_checker < database/migrations/05-remove-snapshot-generation.sql
   ```

5. Confirm both generation columns are absent and all retained records/relationships,
   activity states, and synchronization/last-observed timestamps are unchanged.

`DROP COLUMN IF EXISTS` handles both columns present, either alone, neither, and
reruns after partial completion. Fresh databases require no cleanup. MariaDB DDL
commits implicitly; the two ALTER statements are not atomic together and may acquire
metadata locks or rebuild tables. Schedule schema maintenance appropriately. A failed
second statement can be retried after addressing its cause.

This is forward-only: dropped generation values are discarded, including nonzero
values. There is no down migration. Restoring them would require the backup and a
separately reviewed schema change. Current application code works with or without
these unused columns; application rollback to the current baseline does not require
recreating them. Do not assume an older experimental application is compatible.

## Disposable verification

The MariaDB tests exercise both/one/neither column, nonzero historical values,
repeat execution, row/timestamp/activity preservation, indexes and watchlist foreign
keys. The existing F2 lifecycle now runs after migrations 04 and 05, covering
omission, reactivation without a transition, genuine active transitions, empty
snapshots, rollback, watchlists, and search/options. The full integration suite
reuses these cases inside its isolated test database:

```sh
RUN_BROWSER_TESTS=1 python -B -m pytest tests/integration/test_pipeline.py -v
```

No initialization SQL, scheduler behavior, parser, live data, or application
containers need to change for this cleanup.

Verification for this cleanup: 31 backend tests passed on fresh disposable MariaDB
(no skips), 72 Python unit tests plus 61 subtests, 15 frontend tests, lint and
production build, and all 17 disposable integration cases including both Chrome
scenarios. The initial backend run exposed a pre-removal test baseline; updating
that assertion to compare against the migrated schema resolved it. No application
behavior defect was found. `git diff --check` passed; nothing was staged or committed.
