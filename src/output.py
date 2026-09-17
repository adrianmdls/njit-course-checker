"""Shared console output for automated and manual checks."""


def print_results(started, results, errors, next_run=None):
    print(f"Time: {started.strftime('%I:%M:%S %p').lstrip('0')}")
    if errors:
        print(
            f"Status: Scrape Completed with {errors} "
            f"{'Error' if errors == 1 else 'Errors'}"
        )
    else:
        print("Status: Scrape Completed Successfully")
    next_run_text = (
        next_run.strftime("%I:%M:%S %p").lstrip("0")
        if next_run is not None else "N/A (manual check)"
    )
    print(f"Next Run: {next_run_text}")
    print()
    print("\n".join(results))
    print()
