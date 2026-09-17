"""Look up one course section without changing automated checker state."""

import sys
from datetime import datetime

import requests

from checker import load_config
from njit_scraper import get_sections, parse_section


def main():
    if len(sys.argv) != 2:
        print("Usage: python src/manual_check.py CRN_OR_COURSE")
        print('Example: python src/manual_check.py "CS 288-005"')
        print("Example: python src/manual_check.py 91936")
        return

    try:
        term, courses = load_config()
    except (OSError, ValueError) as error:
        print(f"Could not load courses.json: {error}")
        return

    requested = sys.argv[1]
    if requested in courses:
        crn = requested
        label = courses[crn]
    else:
        for crn, label in courses.items():
            if requested == label:
                break
        else:
            print(f"{requested} is not configured in courses.json.")
            return

    subject = label.split()[0].upper()
    try:
        sections = get_sections(subject, term)
        result = parse_section(sections, crn)
    except (requests.RequestException, ValueError, KeyError, TypeError) as error:
        print(f"{label}: lookup failed: {error}")
        return

    print(f"CHECKED: {datetime.now():%Y-%m-%d %I:%M:%S %p}")
    print("=" * 40)
    print(f"{label} (CRN {crn})")
    print(f"Enrollment: {result['current_enrollment']}/{result['max_enrollment']}")
    print(f"Available: {result['seats_remaining']}")
    print(f"Status: {result['status'].title()}")
    if result["seats_remaining"] > 0 and result["status"] == "OPEN":
        print("🚨 SEAT AVAILABLE!")
    else:
        print("❌ No seats available.")


if __name__ == "__main__":
    main()
