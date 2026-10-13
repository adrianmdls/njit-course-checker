"""Shared console output for automated and manual checks."""


def format_term(term):
    if (
        not isinstance(term, str)
        or len(term) != 6
        or not term.isascii()
        or not term.isdigit()
    ):
        return "Unknown Term"

    year = term[:4]
    suffix = term[4:]

    semesters = {
        "10": "Spring",
        "50": "Summer",
        "90": "Fall",
        "95": "Winter",
    }

    semester = semesters.get(suffix)

    if not semester:
        return "Unknown Term"

    if suffix == "95":
        return f"Winter {year}-{int(year) + 1}"

    return f"{semester} {year}"


def format_course(label, crn, section, notification=False):
    result = (
        f"{label}, CRN: {crn}\n"
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

    if notification:
        result += (
            f"\n[NOTIFICATION]\n{label}, CRN: {crn} is now {section['status']}.\n"
            f"Seats Remaining: {section['seats_remaining']}\n"
        )

    return result


def print_results(started, results, errors, term, next_run=None):
    print(f"Time: {started.strftime('%I:%M:%S %p').lstrip('0')}")

    if errors:
        print(
            f"Status: Check Completed with {errors} "
            f"{'Error' if errors == 1 else 'Errors'}"
        )
    else:
        print("Status: Check Completed Successfully")

    next_run_text = (
        next_run.strftime("%I:%M:%S %p").lstrip("0")
        if next_run is not None
        else "N/A (manual check)"
    )

    print(f"Next Run: {next_run_text}")
    print()

    print("=" * 40)
    print(f"Term: {format_term(term)} ({term})")
    print("=" * 40)

    print("\n".join(results))
    print()
