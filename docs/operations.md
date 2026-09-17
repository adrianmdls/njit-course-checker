# Operations

This document covers normal use of the Docker container.

## Build the Image

From the project root:

```bash
docker build -t njit-course-checker .
```

## Configure Courses

Edit `courses.json` before starting the container.

```json
{
  "term": "202690",
  "courses": {
    "94243": "IT 101-001",
    "91500": "CS 100-003"
  }
}
```

- `term` is the NJIT Banner term code.
- Each key is a CRN.
- Each value is a readable course label.
- The first word of the label must match the Banner subject, such as `IT` or `CS`.

The checker reloads this file every cycle, so course changes do not require rebuilding the image.

## Create Persistent Data Storage

Create the local data directory:

```bash
mkdir -p data
```

This directory stores:

- `state.json`
- `checker.log`
- `notification.log`

Mounting the directory keeps state and logs after the container is recreated.

## Run the Container

```bash
docker run -d \
  --name njit-course-checker \
  --restart unless-stopped \
  -e CHECK_INTERVAL=600 \
  -e TZ=America/New_York \
  -v "$(pwd)/courses.json:/app/courses.json:ro" \
  -v "$(pwd)/data:/app/data" \
  njit-course-checker
```

The checker runs immediately when the container starts.

After each cycle, it waits for `CHECK_INTERVAL` seconds before checking again. The default interval is 600 seconds.

## View Container Output

Follow the live console output:

```bash
docker logs -f njit-course-checker
```

The output shows the cycle summary, course information, errors, and opening notifications.

Press `Ctrl+C` to stop following the logs. This does not stop the container.

## Persistent Logs

Automated checker activity is stored in:

```text
data/checker.log
```

Course opening notifications are stored separately in:

```text
data/notification.log
```

A notification is created only when a previously stored `CLOSED` section changes to `OPEN`.

The first successful check creates the baseline and does not generate an opening notification.

## State

The latest successful course state is stored in:

```text
data/state.json
```

Failed checks do not replace the previous successful state.

The stored term is used with the saved course state so a status from a different term is not treated as a course availability change.

## Manual Check

Run a one-time check inside the running container:

```bash
docker exec njit-course-checker python src/manual_check.py
```

The manual check:

- checks every course in `courses.json`
- prints the current results
- exits after one run
- does not change `state.json`
- does not write to `checker.log`
- does not write to `notification.log`
- does not generate availability-change notifications

## Change the Check Interval

Recreate the container with a different `CHECK_INTERVAL`.

For example, to check every 5 minutes:

```bash
docker rm -f njit-course-checker

docker run -d \
  --name njit-course-checker \
  --restart unless-stopped \
  -e CHECK_INTERVAL=300 \
  -e TZ=America/New_York \
  -v "$(pwd)/courses.json:/app/courses.json:ro" \
  -v "$(pwd)/data:/app/data" \
  njit-course-checker
```

`CHECK_INTERVAL` must be a positive number of seconds.

## Stop and Start

Stop the container:

```bash
docker stop njit-course-checker
```

Start it again:

```bash
docker start njit-course-checker
```

Restart it:

```bash
docker restart njit-course-checker
```

Because the container uses `--restart unless-stopped`, Docker will restart it automatically after a Docker or host restart unless it was manually stopped.

## Rebuild After Code Changes

Rebuild the image:

```bash
docker build -t njit-course-checker .
```

Then recreate the container:

```bash
docker rm -f njit-course-checker
```

Run it again using the normal `docker run` command above.

The mounted `data/` directory keeps the existing state and logs.
