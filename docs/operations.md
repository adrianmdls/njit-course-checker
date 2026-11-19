# Operations

Run commands from the repository root with the local environment configured as
shown in the [README](../README.md#quick-start).

## Running the stack

```sh
docker compose up -d --build --wait
docker compose ps
docker compose logs --tail=100 backend db
tail -f data/checker.log
```

Use `docker compose stop` to pause the stack, `docker compose start` to resume it,
or `docker compose down` to remove its containers and networks while keeping the
database. Run `docker compose up -d --build --wait` again after changing settings
in `.env`. A restart reuses the existing container configuration.

```sh
curl -fsS http://localhost:8080/api/health
```

A healthy response means Express can query MariaDB. Check `data/checker.log`
after a scheduled slot to see whether the checker has fetched and saved sections.
Use `docker compose logs checker` if the checker fails before its log is available.

MariaDB uses the named `mariadb_data` volume. **`docker compose down -v` deletes
that volume and its data.** Keep `data/` too. It holds the checker's logs and
rotation cursor. Back up the database and follow the
[existing-volume migration instructions](../backend/README.md#database-and-migrations)
before applying schema changes.

## Scheduling and monitoring

The Compose checker uses New York time. At :00 and :30 it takes the next subject
from [the department list](../src/departments.json) and checks each configured
term, skipping exact department/term pairs that are watched. At :05, :15, :25,
:35, :45, and :55 it checks watched pairs that match the configured terms and
department list. Multiple watches on the same pair produce one priority check.
When the last watch is removed, the pair returns to regular rotation. The checker
rechecks watch membership before each fetch.

Both schedules take turns fetching, parsing, and submitting snapshots. Due
regular work has priority between watched requests. `BANNER_REQUEST_DELAY` sets
the minimum pause from the end of a Banner request, including failures, to the
start of the next. The default and minimum are five seconds. A full regular
rotation takes about 41 hours when no slots are missed. Slow or large batches
can run past the next tick. Missed ticks are skipped.

### If data stops updating

1. Check `docker compose ps` and `data/checker.log`. Look for the subject, term,
   and whether the failure came from Banner, validation, or the backend.
2. For an API connection failure, check the base URL, DNS, and TLS configuration.
   For HTTP `401`, check that the checker and backend have the same token.
   A `503` can mean the token is unset on the backend or that MariaDB is
   unavailable. Check the backend health response and service logs. See the
   [deployment checks](banner-smoke-test.md#deployment-network-and-tls).
3. If a watched pair is missing from priority checks, confirm the watch was
   saved, the term is in `CHECKER_TERMS`, and the subject is in the department
   list. With no watched pairs, expect activity on the half-hour schedule only.

A regular slot advances the cursor once it has handled its terms, even if a
request fails or both terms were skipped. Use the log to confirm a successful
sync. A submission timeout can leave the result uncertain if Express commits
after the checker stops waiting. An accepted snapshot updates department
completion, while a section's last-seen time changes only when it appears in
the response. See [section activity](section-activity.md).

### Cursor and lock recovery

Keep `data/rotation.json` through restarts. It stores the next subject and last
handled regular slot. An interruption before the cursor is saved leaves the
previous position available for another attempt. A corrupt or unreadable cursor
halts scheduling, preserves the file, and can leave the container showing `Up`.
Look for `Scheduler halted` in `data/checker.log`.

1. Run `docker compose stop checker` before editing the cursor. Save an exact
   copy of `data/rotation.json` under a different filename and check storage
   permissions.
2. Restore a known-good backup if possible. If you need to reconstruct the
   cursor, set `next_subject` to a code in `src/departments.json` and
   `last_slot` to a known completed slot's timestamp. Use a nonnegative Unix
   timestamp divisible by 1800. If the last slot is unknown, `0` is a valid
   checkpoint and can repeat some work.
3. Validate and save the replacement JSON in a separate file in `data/`, then
   rename it over `data/rotation.json`. Keep the backup. Run
   `docker compose start checker` and watch the log through the next regular
   slot. Cursor repair does not require a database reset or migration.

A running checker holds an advisory lock on `data/checker.lock`. If another
checker reports that the directory is in use, stop the extra process. The file
can stay after exit because the OS releases the lock when the process exits.
Deleting it while a checker is running can let another process take a lock on
a new file. Use a single producer across hosts and data directories as well.

## Banner term codes

Set `CHECKER_TERMS` in `.env` to a JSON array of one or two distinct six-digit
strings, such as `CHECKER_TERMS='["202690","202710"]'`. Choose the terms you want
to monitor. The checker has no automatic term discovery.

| Suffix | Term | Example |
|---|---|---|
| `10` | Spring | `202710` is Spring 2027 |
| `50` | Summer | `202750` is Summer 2027 |
| `90` | Fall | `202690` is Fall 2026 |
| `95` | Winter | `202695` is Winter 2026–2027 |

Term changes affect the checker and the search dropdown after Compose recreates
the services. Historical records and watches remain stored. A new term may have
no departments in search until the checker saves some active sections for it.
Reopen the search tab after a sync to refresh the options. See
[backend configuration](../backend/README.md#configuration) for standalone use.
