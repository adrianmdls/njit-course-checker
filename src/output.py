"""Shared console output for automated and manual checks."""


def format_course(label, crn, section, notification=False):
    result = (
        "=" * 40 + f"\n{label}, CRN: {crn}\n"
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
            f"\n[NOTIFICATION]\n{label}, CRN: {crn} is now OPEN.\n"
            f"Seats Remaining: {section['seats_remaining']}\n"
        )
    return result


def print_results(started, results, errors, next_run=None):
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
        if next_run is not None else "N/A (manual check)"
    )
    print(f"Next Run: {next_run_text}")
    print()
    print("\n".join(results))
    print()
