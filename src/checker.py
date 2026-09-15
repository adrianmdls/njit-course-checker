import json
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


def main():
    try:
        with COURSES_FILE.open() as file:
            courses = json.load(file)
    except (OSError, json.JSONDecodeError) as error:
        print(f"Could not load courses.json: {error}")
        return

    if not isinstance(courses, dict) or any(
        not isinstance(label, str) or not label.strip()
        for label in courses.values()
    ):
        print("courses.json must map CRNs to nonempty course labels.")
        return

    if not courses:
        print("No courses configured in courses.json.")
        return

    try:
        state = load_state()
    except (OSError, ValueError) as error:
        print(f"Could not load previous state: {error}")
        return

    state_changed = False

    subjects = {}
    for crn, label in courses.items():
        subject = label.split()[0].upper()
        subjects.setdefault(subject, []).append((crn, label))

    for subject, configured_courses in subjects.items():
        try:
            sections = get_sections(subject, TERM)
        except (requests.RequestException, ValueError) as error:
            print(f"Could not retrieve {subject}: {error}")
            continue

        for crn, label in configured_courses:
            try:
                section = parse_section(sections, crn)
            except (ValueError, KeyError, TypeError) as error:
                print(f"{label} (CRN {crn}): check failed — {error}")
                continue

            previous = state["courses"].get(crn, {})

            if (
                previous.get("status") == "CLOSED"
                and section["status"] == "OPEN"
            ):
                print(f"AVAILABLE: {label} (CRN {crn}) is now OPEN!")

            state["courses"][crn] = {
                "status": section["status"],
                "seats_remaining": section["seats_remaining"],
            }
            state_changed = True

            print(
                f"{label} (CRN {crn}): {section['status']} | "
                f"{section['current_enrollment']}/"
                f"{section['max_enrollment']} enrolled | "
                f"{section['seats_remaining']} seats remaining"
            )

    if state_changed:
        try:
            save_state(state)
        except OSError as error:
            print(f"Could not save state: {error}")


if __name__ == "__main__":
    main()
