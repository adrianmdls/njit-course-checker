import requests

from src.database import (
    is_department_cache_fresh,
    search_cached_courses,
)
from src.department_sync import sync_department
from src.sync_lock import department_lock


def search_courses(subject, course_number, term):
    """Search courses using cached data or fresh Banner results."""
    subject = subject.strip().upper()
    course_number = str(course_number).strip().upper()
    term = str(term).strip()

    # Check whether cached department data is recent.
    if is_department_cache_fresh(subject, term):
        return {
            "sections": search_cached_courses(
                subject, course_number, term
            ),
            "source": "cache",
            "stale": False,
        }

    # Cache is missing or expired.
    try:
        with department_lock(subject, term, timeout=30):
            if is_department_cache_fresh(subject, term):
                return {
                    "sections": search_cached_courses(
                        subject, course_number, term
                    ),
                    "source": "cache",
                    "stale": False,
                }

            sync_department(subject, term)

    except (requests.RequestException, ValueError, TimeoutError):
        # If Banner is unavailable, try existing cached results.
        cached = search_cached_courses(
            subject, course_number, term
        )

        if cached:
            return {
                "sections": cached,
                "source": "cache",
                "stale": True,
            }

        raise

    return {
        "sections": search_cached_courses(
            subject, course_number, term
        ),
        "source": "banner",
        "stale": False,
    }


if __name__ == "__main__":
    result = search_courses("IT", "101", "202710")

    print("Source:", result["source"])
    print("Stale:", result["stale"])
    print("Sections found:", len(result["sections"]))

    for section in result["sections"]:
        print(
            section["crn"],
            section["section_number"],
            section["status"],
            f'{section["enrolled"]}/{section["capacity"]}'
        )
