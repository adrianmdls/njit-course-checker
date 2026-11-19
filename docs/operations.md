# Operations

Run commands from the repository root. See the [root guide](../README.md) for
installation, monitoring targets, and legacy-database upgrades, and the
[backend guide](../backend/README.md) for API/configuration details.

## Routine commands

```sh
docker compose ps                    # Service status
docker compose logs -f               # Follow service output; Ctrl+C stops following
docker compose stop                 # Stop without removing containers
docker compose start                # Start existing containers
docker compose restart              # Restart without applying changed configuration
docker compose up -d --build --wait  # Rebuild/recreate after code or configuration changes
docker compose down                 # Remove containers and networks; retain database volume
```

MariaDB persists in a named volume. Checker activity is logged to
`data/checker.log`, mounted from the host. Do not use `docker compose down -v`
unless you intend to delete the database. The current checker does not write
`state.json` or `notification.log`.

## Monitoring and manual checks

Regular synchronization rotates one NJIT subject at :00 and :30 for the one or
two terms in `CHECKER_TERMS`. Priority synchronization reads actual Watchlists
at :05/:15/:25/:35/:45/:55, filtered to the same configured terms and allowlist.
Browser Add/Remove now persist the authenticated user's database Watchlists.
The existing watched-only endpoint promotes/demotes distinct pairs across all
users; the scheduler retains its configured-term and NJIT allowlist filters.
Backend explicit
`CHECKER_MONITORING_TARGETS` remains available to legacy/manual callers but does
not grant scheduled priority. `CHECK_INTERVAL` is retired.

`BANNER_REQUEST_DELAY` is at least 5 seconds, measured from Banner completion to
the next start. Both loops share one fetch/parse/submit gate; due regular work has priority
between watched requests. Active batches
finish; missed ticks are skipped. Term or delay changes require a later checker
recreation; no running application containers were recreated during Phase 2.
See [Phase 2](phase-2-sync.md) for configuration and scheduling details.

Keep `data/rotation.json` across restarts. It records the next subject and last
completed regular slot; interrupted department slots keep the previous cursor.
Do not delete it to troubleshoot a request failure. A corrupt/unreadable cursor
halts scheduling, preserves the original file and leaves the process alive to
avoid automatic restart loops. Follow the documented
[cursor recovery procedure](phase-2-sync.md#cursor-recovery). A second checker sharing this directory
is refused through `data/checker.lock`; separate data directories are not a
cross-host singleton mechanism. No database migration is needed.

The supported read-only manual command is:

```sh
docker compose exec checker manual_check
```

Run it only while the automated checker is stopped to avoid independent Banner
requests. It retrieves legacy monitored departments from Express, fetches Banner, and prints
department summaries without submitting snapshots, changing database records,
or sending notifications. If the checker is stopped, use
`docker compose run --rm --no-deps checker manual_check` with the backend running.
For one-shot synchronization and deterministic verification, use the
[smoke-test guide](banner-smoke-test.md); run only one synchronization producer.

Authenticated search reads synchronized MariaDB records. Searching an
unsynchronized department/term returns an empty list and never triggers Banner.
The UI loads available terms and departments from `/api/courses/options`, chooses
the first configured term initially, and shows only departments available for the
selected term. Select a department before searching; there is no all-department
search. Changing terms clears an unavailable department selection. Changing the
term or department clears results and prevents delayed responses from restoring
the previous search; other filters are preserved.
Catalog options and searches never initiate synchronization. If no local catalog
data exists, the form explains this and disables search. Reopen the search tab
after a synchronization to refresh its options. Compose maps backend SEARCH_TERMS
to CHECKER_TERMS. Configured terms remain visible
even before ingestion; their department selection and search stay disabled until
active linked catalog records exist. Historical terms are excluded from dropdown
options, but their rows and watches remain intact and direct searches still work.
Standalone backend users should set SEARCH_TERMS explicitly to use this policy.

Synchronization preserves omitted sections exactly. A structurally valid Banner
response can still be incomplete, so omission no longer marks a section inactive.
Only explicit observations update/reactivate sections and their last-seen times.
Historical OPEN/CLOSED/CANCELLED values may be stale; department completion is not
proof that every stored section was observed. Existing inactive rows stay inactive
until observed again. See [section preservation](section-activity.md). No schema
change or automatic repair of historical activity flags accompanies this safeguard.

## Banner term codes

The first four digits identify the year:

| Suffix | Term | Example |
|---|---|---|
| `10` | Spring | `202710` = Spring 2027 |
| `50` | Summer | `202750` = Summer 2027 |
| `90` | Fall | `202690` = Fall 2026 |
| `95` | Winter | `202695` = Winter 2026–2027 |

Use the appropriate real term when configuring monitoring; examples are not
automatically active targets.

## Notifications

Notification delivery is unavailable.
