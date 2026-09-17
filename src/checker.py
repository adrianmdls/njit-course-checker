import json
import logging
import os
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests

from njit_scraper import get_sections, parse_section


PROJECT_ROOT = Path(__file__).resolve().parent.parent
COURSES_FILE = PROJECT_ROOT / "courses.json"
STATE_FILE = PROJECT_ROOT / "data" / "state.json"
LOG_FILE = PROJECT_ROOT / "data" / "checker.log"
logger = logging.getLogger(__name__)


def load_config():
    with COURSES_FILE.open() as file:
        config = json.load(file)
    if (
        not isinstance(config, dict)
        or not isinstance(config.get("term"), str)
        or not config["term"].strip()
        or not isinstance(config.get("courses"), dict)
        or any(
            not isinstance(label, str) or not label.strip()
            for label in config["courses"].values()
        )
    ):
        raise ValueError("Configuration must contain a nonempty term string and a courses object with nonempty labels.")
    return config["term"], config["courses"]


def load_state(term):
    try:
        with STATE_FILE.open() as file:
            state = json.load(file)
    except FileNotFoundError:
        return {"term": term, "courses": {}}

    if state == {}:
        return {"term": term, "courses": {}}

    if (
        not isinstance(state, dict)
        or not isinstance(state.get("term"), str)
        or not isinstance(state.get("courses"), dict)
        or any(
            not isinstance(section, dict)
            for section in state["courses"].values()
        )
    ):
        raise ValueError("State must contain a term and a courses object.")

    if state["term"] != term:
        return {"term": term, "courses": {}}

    return state


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temporary_file = STATE_FILE.with_suffix(".tmp")

    with temporary_file.open("w") as file:
        json.dump(state, file, indent=2)
        file.write("\n")

    temporary_file.replace(STATE_FILE)


def check_once():
    """Check courses, save successful state, and collect console output."""
    results = []
    errors = 0
    try:
        term, courses = load_config()
    except (OSError, ValueError) as error:
        logger.error("Could not load courses.json: %s", error)
        return [f"ERROR: Could not load courses.json: {error}"], 1

    if not courses:
        logger.info("No courses configured in courses.json.")
        return ["No courses configured in courses.json."], 0

    try:
        state = load_state(term)
    except (OSError, ValueError) as error:
        logger.error("Could not load previous state: %s", error)
        return [f"ERROR: Could not load previous state: {error}"], len(courses)

    state_changed = False

    subjects = {}
    for crn, label in courses.items():
        subject = label.split()[0].upper()
        subjects.setdefault(subject, []).append((crn, label))

    for subject, configured_courses in subjects.items():
        try:
            sections = get_sections(subject, term)
        except (requests.RequestException, ValueError) as error:
            errors += len(configured_courses)
            for crn, label in configured_courses:
                logger.error(
                    "%s | CRN %s | Could not retrieve %s course data: %s",
                    label, crn, subject, error,
                )
                results.append(
                    "=" * 40 + f"\n{label}, CRN: {crn}\n"
                    f"ERROR: Could not retrieve {subject} course data: {error}\n"
                )
            continue

        for crn, label in configured_courses:
            heading = "=" * 40 + f"\n{label}, CRN: {crn}\n"
            try:
                section = parse_section(sections, crn)
                details = (
                    f"Instructor: {section['instructor']}\n"
                    f"Days: {section['days']}\n"
                    f"Meeting Time: {section['meeting_time']}\n"
                    f"Location: {section['location']}\n"
                    f"Delivery Mode: {section['delivery_mode']}\n"
                    f"Credits: {section['credits']}\n"
                    f"Current Enrollment: {section['current_enrollment']} / "
                    f"{section['max_enrollment']}\n"
                    f"Seats Remaining: {section['seats_remaining']}\n"
                    f"STATUS: {section['status']}\n"
                )
            except (ValueError, KeyError, TypeError) as error:
                errors += 1
                logger.error("%s | CRN %s | Could not check course: %s", label, crn, error)
                results.append(heading + f"ERROR: Could not check course: {error}\n")
                continue

            logger.info(
                "%s | CRN %s | %s | %s seats remaining",
                label, crn, section["status"], section["seats_remaining"],
            )
            previous = state["courses"].get(crn, {})
            if (
                previous.get("status") == "CLOSED"
                and section["status"] == "OPEN"
            ):
                details += (
                    f"\n[NOTIFICATION]\n{label}, CRN: {crn} is now OPEN.\n"
                    f"Seats Remaining: {section['seats_remaining']}\n"
                )
            results.append(heading + details)

            state["courses"][crn] = {
                "status": section["status"],
                "seats_remaining": section["seats_remaining"],
            }
            state_changed = True

    if state_changed:
        try:
            save_state(state)
        except OSError as error:
            errors += 1
            logger.error("Could not save state: %s", error)
            results.append(f"ERROR: Could not save state: {error}")

    return results, errors


def main():
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=LOG_FILE,
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        encoding="utf-8",
    )
    try:
        interval = int(os.environ.get("CHECK_INTERVAL", "600"))
        if interval <= 0:
            raise ValueError
    except ValueError:
        logger.error("CHECK_INTERVAL must be a positive integer in seconds.")
        print("CHECK_INTERVAL must be a positive integer in seconds.")
        return 1

    print(f"Checking courses every {interval} seconds. Press Ctrl+C to stop.")
    try:
        while True:
            started = datetime.now()
            logger.info("Check cycle started")
            results, errors = check_once()
            if errors:
                logger.error("Check cycle completed with %s error(s)", errors)
            else:
                logger.info("Check cycle completed successfully")
            next_run = datetime.now() + timedelta(seconds=interval)

            print(f"Time: {started.strftime('%I:%M:%S %p').lstrip('0')}")
            if errors:
                print(
                    f"Status: Scrape Completed with {errors} "
                    f"{'Error' if errors == 1 else 'Errors'}"
                )
            else:
                print("Status: Scrape Completed Successfully")
            print(f"Next Run: {next_run.strftime('%I:%M:%S %p').lstrip('0')}")
            print()
            print("\n".join(results))
            print()
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nCourse checker stopped.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
