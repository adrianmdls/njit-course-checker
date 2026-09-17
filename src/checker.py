import json
import logging
import os
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests

from njit_scraper import get_sections, parse_section
from output import format_course, print_results


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


def check_once(persist_state=True):
    """Check configured courses; optionally persist state and log activity."""
    results = []
    errors = 0
    try:
        term, courses = load_config()
    except (OSError, ValueError) as error:
        if persist_state:
            logger.error("Could not load courses.json: %s", error)
        return [f"ERROR: Could not load courses.json: {error}"], 1

    if not courses:
        if persist_state:
            logger.info("No courses configured in courses.json.")
        return ["No courses configured in courses.json."], 0

    try:
        state = load_state(term) if persist_state else {"term": term, "courses": {}}
    except (OSError, ValueError) as error:
        if persist_state:
            logger.error("Could not load previous state: %s", error)
        return [f"ERROR: Could not load previous state: {error}"], len(courses)

    state_updated = False

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
                if persist_state:
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
                previous = state["courses"].get(crn, {})
                became_open = (
                    previous.get("status") == "CLOSED"
                    and section["status"] == "OPEN"
                )
                result = format_course(
                    label, crn, section, notification=became_open,
                )
            except (ValueError, KeyError, TypeError) as error:
                errors += 1
                if persist_state:
                    logger.error("%s | CRN %s | Could not check course: %s", label, crn, error)
                results.append(heading + f"ERROR: Could not check course: {error}\n")
                continue

            if persist_state:
                logger.info(
                    "%s | CRN %s | %s | %s/%s enrolled | %s seats remaining",
                    label,
                    crn,
                    section["status"],
                    section["current_enrollment"],
                    section["max_enrollment"],
                    section["seats_remaining"],
                )
            results.append(result)

            state["courses"][crn] = {
                "status": section["status"],
                "seats_remaining": section["seats_remaining"],
            }
            state_updated = True

    if persist_state and state_updated:
        try:
            save_state(state)
        except OSError as error:
            errors += 1
            logger.error("Could not save state: %s", error)
            results.append(f"ERROR: Could not save state: {error}")

    return results, errors


def setup_logging():
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=LOG_FILE,
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        encoding="utf-8",
    )


def main():
    setup_logging()
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

            print_results(started, results, errors, next_run)
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nCourse checker stopped.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
