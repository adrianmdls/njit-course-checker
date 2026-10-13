# Operations

This document covers normal use of the Dockerized NJIT Course Availability Checker.

## Configure Courses

Edit `courses.json` before starting the container.

```json
{
  "term": "202690",
  "courses": {
    "94353": "IT 610-101",
    "91923": "CS 288-005"
  }
}
```

- `term` is the NJIT Banner term code.
- Each key is a CRN.
- Each value is a readable course label.
- The first word of the label must match the Banner subject, such as `IT` or `CS`.

The checker reloads this file every cycle, so course changes do not require rebuilding the image.

#### Banner Term Codes

The NJIT Banner term codes used by this project follow this pattern: the first four digits represent the year, and the final two digits represent the term.

| Code | Term |
|---|---|
| `10` | Spring |
| `50` | Summer |
| `90` | Fall |
| `95` | Winter |

Examples:

- `202610` = Spring 2026
- `202650` = Summer 2026
- `202690` = Fall 2026
- `202695` = Winter 2026-2027

## Persistent Data

Runtime data is stored in the local `data/` directory.

```text
data/
├── state.json
├── checker.log
└── notification.log
```

The directory is bind-mounted into the container so state and logs remain available if the container is stopped, removed, or recreated.

If the directory does not exist yet, create it with:

```bash
mkdir -p data
```

## Build and Start

From the project root:

```bash
docker compose up -d --build
```

This command:

- builds the custom Docker image
- creates the container
- starts the checker in the background
- applies the configured restart policy
- mounts `courses.json` and `data/`

The checker runs immediately when the container starts.

After each cycle, it waits for `CHECK_INTERVAL` seconds before checking again. The default interval is 600 seconds.

## View Container Output

To follow the live console output:

```bash
docker compose logs -f
```

The output shows the cycle summary, course information, errors, and status-change events.

Press `Ctrl+C` to stop following the logs. This does not stop the container.

## Persistent Logs

Automated checker activity and errors are stored in:

```text
data/checker.log
```

Course status-change events are stored separately in:

```text
data/notification.log
```

The checker records both:

- `CLOSED → OPEN`
- `OPEN → CLOSED`

The first successful check establishes the baseline and does not create a status-change event.

## State

The latest successful course state is stored in:

```text
data/state.json
```

Failed checks do not overwrite the previous successful state.

If the configured term changes, state from the previous term is not used for availability comparisons. The new term's state is saved after a successful course check.

## Manual Check

Run a one-time check inside the running container:

```bash
docker compose exec njit-course-checker manual_check
```

Alternatively, run the same command directly with Docker:

```bash
docker exec njit-course-checker manual_check
```

The manual check:

- checks every course in `courses.json`
- prints the current results
- exits after one run
- does not modify `state.json`
- does not write to `checker.log`
- does not write to `notification.log`
- does not create availability-change events

## Change the Check Interval

The check interval is configured in `compose.yaml`.

For example:

```yaml
environment:
  CHECK_INTERVAL: 300
  TZ: America/New_York
```

`CHECK_INTERVAL` must be a positive integer representing seconds.

Examples:

- `300` = 5 minutes
- `600` = 10 minutes
- `1800` = 30 minutes

After changing `compose.yaml`, recreate the container:

```bash
docker compose up -d
```

Docker Compose will apply the updated configuration.

## Stop and Start

Stop the container without removing it:

```bash
docker compose stop
```

Start it again:

```bash
docker compose start
```

Restart it:

```bash
docker compose restart
```

Because the container uses `restart: unless-stopped`, Docker will restart it after a Docker or host restart unless it was manually stopped.

## Remove the Container

Stop and remove the Compose-managed container:

```bash
docker compose down
```

The local `data/` directory is not removed, so saved state and logs remain available.

## Rebuild After Code Changes

After modifying application code or the Dockerfile, rebuild and recreate the container:

```bash
docker compose up -d --build
```

The mounted `data/` directory preserves the existing state and logs.

## Check Container Status

View the current Compose service status:

```bash
docker compose ps
```
