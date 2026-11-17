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

Monitoring targets come from backend Watchlists and `CHECKER_MONITORING_TARGETS`.
The browser's demo watchlist does not update either source. Changing explicit
targets requires recreating the backend; changing `CHECK_INTERVAL` requires
recreating the checker. The interval is a positive number of seconds to wait
after each completed cycle, defaulting to 600.

The supported read-only manual command is:

```sh
docker compose exec checker manual_check
```

It retrieves monitored departments from Express, fetches Banner, and prints
department summaries without submitting snapshots, changing database records,
or sending notifications. If the checker is stopped, use
`docker compose run --rm --no-deps checker manual_check` with the backend running.
For one-shot synchronization and deterministic verification, use the
[smoke-test guide](banner-smoke-test.md); run only one synchronization producer.

Authenticated search reads synchronized MariaDB records. Searching an
unsynchronized department/term returns an empty list and never triggers Banner.
The UI loads available terms and departments from `/api/courses/options`, chooses
the newest local term initially, and shows only departments available for the
selected term. Changing terms clears an unavailable department selection.
Catalog options and searches never initiate synchronization. If no local catalog
data exists, the form explains this and disables search. Reopen the search tab
after a synchronization to refresh its options. Existing rows remain searchable
even when their department/term is no longer actively monitored.

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

Automatic Discord and email notifications are inactive. The local dashboard
notification toggle is a demo control. The retained Discord utility can still
send a manual message when `DISCORD_WEBHOOK_URL` is configured in the checker:

```sh
docker compose exec checker python -c \
  'from src.discord_notify import send_discord_notification; print(send_discord_notification("NJIT Course Checker: Test notification"))'
```

It returns `True` on success and `False` when disabled or unsuccessful. Recreate
the checker after changing the webhook setting. This manual command sends an
actual message; it is not part of automated verification.
