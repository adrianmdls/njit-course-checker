"""Look up one course section without changing automated checker state."""

import argparse
from datetime import datetime

import requests

from checker import TERM
from njit_scraper import find_section, get_sections


def main():
    parser = argparse.ArgumentParser(
        usage="python src/manual_check.py SUBJECT COURSE SECTION",
        epilog="Example: python src/manual_check.py CS 288 005",
    )
    parser.add_argument("subject", metavar="SUBJECT")
    parser.add_argument("course", metavar="COURSE")
    parser.add_argument("section", metavar="SECTION")
    args = parser.parse_args()

    subject = args.subject.strip().upper()
    course = args.course.strip().upper()
    section = args.section.strip().upper()
    if not all(value.isascii() and value.isalnum()
               for value in (subject, course, section)):
        parser.error("SUBJECT, COURSE, and SECTION must contain letters or digits.")
    if not subject.isalpha() or not course[0].isdigit():
        parser.error("SUBJECT must be letters and COURSE must begin with a digit.")
    if section.isdigit():
        section = section.zfill(3)

    label = f"{subject} {course}-{section}"
    try:
        sections = get_sections(subject, TERM)
        result = find_section(sections, subject, course, section)
    except (requests.RequestException, ValueError, KeyError, TypeError) as error:
        print(f"{label}: lookup failed: {error}")
        return 1

    print(f"CHECKED: {datetime.now():%Y-%m-%d %I:%M:%S %p}")
    print()
    print("=" * 40)
    if result is None:
        print(label)
        print(f"⚠️ Course section not found for term {TERM}.")
        return 1

    print(f"{label} (CRN {result['crn']})")
    print(f"Enrollment: {result['current_enrollment']}/{result['max_enrollment']}")
    print(f"Available: {result['seats_remaining']}")
    print(f"Status: {result['status'].title()}")
    if result["seats_remaining"] > 0 and result["status"] == "OPEN":
        print("🚨 SEAT AVAILABLE!")
    else:
        print("❌ No seats available.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
