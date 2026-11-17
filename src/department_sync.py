from src.checker_api import submit_department_snapshot
from src.njit_scraper import get_sections, parse_all_sections


def sync_department(subject, term, data=None):
    """Fetch/parse a department and let Express synchronize its records."""
    subject = subject.strip().upper()
    term = str(term).strip()

    if data is None:
        data = get_sections(subject, term)

    sections = parse_all_sections(data)

    if not sections:
        raise ValueError("No sections found. Skipping synchronization.")

    result = submit_department_snapshot(subject, term, sections)
    print(
        f"Synchronized {result['courses']} courses and "
        f"{result['sections']} sections for {subject} {term}"
    )


if __name__ == "__main__":
    sync_department("IT", "202710")
