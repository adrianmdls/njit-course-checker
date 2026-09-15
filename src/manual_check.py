"""Look up one course section without changing automated checker state."""

import sys
from datetime import datetime

import requests

from checker import TERM
from njit_scraper import find_section, get_sections


def main():
    if len(sys.argv) != 4:
        print("Usage: python src/manual_check.py SUBJECT COURSE SECTION")
        print("Example: python src/manual_check.py CS 288 005")
        return

    subject = sys.argv[1].upper()
    course = sys.argv[2]
    section = sys.argv[3].zfill(3)

    label = f"{subject} {course}-{section}"
    try:
        sections = get_sections(subject, TERM)
        result = find_section(sections, subject, course, section)
    except (requests.RequestException, ValueError) as error:
        print(f"{label}: lookup failed: {error}")
        return

    print(f"CHECKED: {datetime.now():%Y-%m-%d %I:%M:%S %p}")
    print("=" * 40)
    if result is None:
        print(label)
        print("⚠️ Course section not found.")
        return

    print(f"{label} (CRN {result['crn']})")
    print(f"Enrollment: {result['current_enrollment']}/{result['max_enrollment']}")
    print(f"Available: {result['seats_remaining']}")
    print(f"Status: {result['status'].title()}")
    if result["seats_remaining"] > 0 and result["status"] == "OPEN":
        print("🚨 SEAT AVAILABLE!")
    else:
        print("❌ No seats available.")


if __name__ == "__main__":
    main()
