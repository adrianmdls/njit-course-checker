import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests

from njit_scraper import get_sections, parse_section


PROJECT_ROOT = Path(__file__).resolve().parent.parent
COURSES_FILE = PROJECT_ROOT / "courses.json"
TERM = "202690"
STATE_FILE = PROJECT_ROOT / "data" / "state.json"


def load_state():
    try:
        with STATE_FILE.open() as file:
            state = json.load(file)
    except FileNotFoundError:
        return {"term": TERM, "courses": {}}

    if state == {}:
        return {"term": TERM, "courses": {}}

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

    if state["term"] != TERM:
        return {"term": TERM, "courses": {}}

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
        with COURSES_FILE.open() as file:
            courses = json.load(file)
    except (OSError, json.JSONDecodeError) as error:
        return [f"ERROR: Could not load courses.json: {error}"], 1

    if not courses:
        return ["No courses configured in courses.json."], 0

    try:
        state = load_state()
    except (OSError, ValueError) as error:
        return [f"ERROR: Could not load previous state: {error}"], len(courses)

    state_changed = False

    subjects = {}
    for crn, label in courses.items():
        subject = label.split()[0].upper()
        subjects.setdefault(subject, []).append((crn, label))

    for subject, configured_courses in subjects.items():
        try:
            sections = get_sections(subject, TERM)
        except (requests.RequestException, ValueError) as error:
            errors += len(configured_courses)
            for crn, label in configured_courses:
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
                results.append(heading + f"ERROR: Could not check course: {error}\n")
                continue

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
            results.append(f"ERROR: Could not save state: {error}")

    return results, errors


def main():
    try:
        interval = int(os.environ.get("CHECK_INTERVAL", "600"))
        if interval <= 0:
            raise ValueError
    except ValueError:
        print("CHECK_INTERVAL must be a positive integer in seconds.")
        return 1

    print(f"Checking courses every {interval} seconds. Press Ctrl+C to stop.")
    try:
        while True:
            started = datetime.now()
            results, errors = check_once()
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
