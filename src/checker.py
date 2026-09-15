import json
from pathlib import Path

import requests

from njit_scraper import get_sections, parse_section


PROJECT_ROOT = Path(__file__).resolve().parent.parent
COURSES_FILE = PROJECT_ROOT / "courses.json"
TERM = "202690"


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

            print(
                f"{label} (CRN {crn}): {section['status']} | "
                f"{section['current_enrollment']}/"
                f"{section['max_enrollment']} enrolled | "
                f"{section['seats_remaining']} seats remaining"
            )


if __name__ == "__main__":
    main()