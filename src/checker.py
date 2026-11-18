"""Poll monitored departments sequentially; Express owns database access."""

import logging
import os
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests

from src.checker_api import get_monitoring_targets, submit_department_snapshot
from src.njit_scraper import get_sections, parse_all_sections
from src.output import print_results


LOG_FILE = Path(__file__).resolve().parent.parent / "data" / "checker.log"
logger = logging.getLogger(__name__)


def check_once(persist_state=True):
    """Fetch complete snapshots, optionally submitting them to Express."""
    try:
        targets = get_monitoring_targets()
    except (requests.RequestException, ValueError) as error:
        logger.error("Could not load monitoring targets: %s", error)
        return [f"ERROR: Could not load monitoring targets: {error}"], 1, None

    if not targets:
        return ["No departments configured for monitoring."], 0, None

    results = []
    errors = 0
    for target in targets:
        subject, term = target["subject"], target["term"]
        try:
            sections = parse_all_sections(get_sections(subject, term))
            if persist_state:
                counts = submit_department_snapshot(subject, term, sections)
                message = (
                    f"{subject} {term}: synchronized {counts['courses']} courses, "
                    f"{counts['sections']} sections, {counts['status_changes']} status changes."
                )
                logger.info(message)
            else:
                message = f"{subject} {term}: retrieved {len(sections)} sections (read-only)."
            results.append(message)
        except (requests.RequestException, ValueError, KeyError, TypeError) as error:
            errors += 1
            logger.error("Department check failed for %s %s: %s", subject, term, error)
            results.append(f"ERROR: Department {subject}, term {term}: {error}")

    terms = {target["term"] for target in targets}
    return results, errors, next(iter(terms)) if len(terms) == 1 else None


def setup_logging():
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=LOG_FILE,
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
        encoding="utf-8",
    )


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
