import json
import logging
import os
import time
import pymysql
from datetime import datetime, timedelta
from pathlib import Path
from database import get_sections_to_check, save_section

import requests

from discord_notify import send_discord_notification

from njit_scraper import get_sections, parse_section
from output import format_course, print_results


PROJECT_ROOT = Path(__file__).resolve().parent.parent
COURSES_FILE = PROJECT_ROOT / "courses.json"
STATE_FILE = PROJECT_ROOT / "data" / "state.json"
LOG_FILE = PROJECT_ROOT / "data" / "checker.log"
NOTIFICATION_LOG_FILE = PROJECT_ROOT / "data" / "notification.log"

logger = logging.getLogger(__name__)
notification_logger = logging.getLogger("notifications")


def load_config():
    with COURSES_FILE.open() as file:
        config = json.load(file)

    if (
        not isinstance(config, dict)
        or not isinstance(config.get("term"), str)
        or len(config["term"]) != 6
        or not config["term"].isascii()
        or not config["term"].isdigit()
        or config["term"][4:] not in ("10", "50", "90", "95")
        or not isinstance(config.get("courses"), dict)
        or any(
            not isinstance(label, str) or not label.strip()
            for label in config["courses"].values()
        )
    ):
        raise ValueError(
            "Configuration must contain a six-digit term string "
            "with suffix 10, 50, 90, or 95 "
            "and a courses object with nonempty labels."
        )

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
    """Check sections from MariaDB and update enrollment data."""
    results = []
    errors = 0

    # 1. Load monitored sections from MariaDB
    try:
        courses = get_sections_to_check()

    except pymysql.MySQLError as error:
        if persist_state:
            logger.error("Could not load sections: %s", error)

        return [f"ERROR: Database unavailable: {error}"], 1, None

    if not courses:
        return ["No sections configured for monitoring."], 0, None

    # 2. Group sections by term and subject
    groups = {}

    for course in courses:
        key = (course["term"], course["subject"])
        groups.setdefault(key, []).append(course)

    # 3. Retrieve Banner data for each group
    for (term, subject), configured_courses in groups.items():
        try:
            sections = get_sections(subject, term)

        except (requests.RequestException, ValueError) as error:
            errors += len(configured_courses)

            if persist_state:
                logger.error(
                    "Could not retrieve %s for term %s: %s",
                    subject, term, error
                )

            for course in configured_courses:
                results.append(
                    f"ERROR: CRN {course['crn']}: {error}"
                )

            continue

        # 4. Process each section in the group
        for course in configured_courses:
            crn = course["crn"]
            section_number = course["section_number"] or "Unknown"
            label = f"{subject} Section {section_number}"

            try:
                section = parse_section(sections, crn)

                previous_status = course["status"]
                current_status = section["status"]

                status_changed = (
                    previous_status in ("OPEN", "CLOSED")
                    and current_status in ("OPEN", "CLOSED")
                    and previous_status != current_status
                )

                # 5. Persist successful checks
                if persist_state:
                    save_section(subject, term, section)

                result = format_course(
                    label,
                    crn,
                    section,
                    notification=persist_state and status_changed,
                )

                # 6. Preserve existing Discord notifications
                if persist_state and status_changed:
                    message = (
                        f"{label} | Term {term} | "
                        f"CRN {crn} | {current_status} | "
                        f"{section['seats_remaining']} seats remaining"
                    )

                    notification_logger.info(message)
                    send_discord_notification(message)

                results.append(result)

                if persist_state:
                    logger.info(
                        "%s | Term %s | CRN %s | %s | %s/%s enrolled",
                        label,
                        term,
                        crn,
                        current_status,
                        section["current_enrollment"],
                        section["max_enrollment"],
                    )

            except (
                ValueError,
                KeyError,
                TypeError,
                pymysql.MySQLError,
            ) as error:
                errors += 1

                if persist_state:
                    logger.error(
                        "%s | Term %s | CRN %s | Check failed: %s",
                        label, term, crn, error
                    )

                results.append(
                    f"ERROR: {label}, CRN {crn}: {error}"
                )

    # 7. Return term for console output
    terms = {course["term"] for course in courses}

    display_term = (
        next(iter(terms)) if len(terms) == 1 else None
    )

    return results, errors, display_term


def setup_logging():
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

    logging.basicConfig(
        filename=LOG_FILE,
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        encoding="utf-8",
    )

    if not notification_logger.handlers:
        notification_handler = logging.FileHandler(
            NOTIFICATION_LOG_FILE,
            encoding="utf-8",
        )

        notification_handler.setFormatter(
            logging.Formatter(
                "%(asctime)s | %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
        )

        notification_logger.addHandler(notification_handler)

    notification_logger.setLevel(logging.INFO)
    notification_logger.propagate = False


def main():
    setup_logging()

    try:
        interval = int(os.environ.get("CHECK_INTERVAL", "600"))

        if interval <= 0:
            raise ValueError

    except ValueError:
        logger.error(
            "CHECK_INTERVAL must be a positive integer in seconds."
        )
        print("CHECK_INTERVAL must be a positive integer in seconds.")
        return 1

    print(
        f"Checking courses every {interval} seconds. "
        "Press Ctrl+C to stop."
    )

    try:
        while True:
            started = datetime.now()

            logger.info("Check cycle started")

            results, errors, term = check_once()

            if errors:
                logger.error(
                    "Check cycle completed with %s error(s)",
                    errors,
                )
            else:
                logger.info("Check cycle completed successfully")

            next_run = datetime.now() + timedelta(seconds=interval)

            print_results(
                started,
                results,
                errors,
                term,
                next_run,
            )

            time.sleep(interval)

    except KeyboardInterrupt:
        print("\nCourse checker stopped.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
