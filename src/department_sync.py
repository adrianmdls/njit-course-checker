from src.njit_scraper import get_sections, parse_all_sections
from src.database import get_connection


def sync_department(subject, term, data=None):
    """Synchronize a department's courses and sections."""
    subject = subject.strip().upper()

    if data is None:
        data = get_sections(subject, term)

    sections = parse_all_sections(data)

    if not sections:
        raise ValueError("No sections found. Skipping synchronization.")

    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            course_ids = {}

            for section in sections:
                course_subject, course_number = section["course"].split(maxsplit=1)
                course_subject = course_subject.upper()
                title = section["title"].split(" - ", 1)[-1]
                key = (course_subject, course_number)

                if key not in course_ids:
                    cursor.execute(
                        """
                        INSERT INTO Courses (subject, course_number, title)
                        VALUES (%s, %s, %s)
                        ON DUPLICATE KEY UPDATE title = VALUES(title)
                        """,
                        (course_subject, course_number, title),
                    )
                    cursor.execute(
                        """
                        SELECT id FROM Courses
                        WHERE subject = %s AND course_number = %s
                        """,
                        key,
                    )
                    course_ids[key] = cursor.fetchone()[0]

                course_id = course_ids[key]
                crn = section["crn"]

                # Lock the existing record, if any, while deciding whether it
                # is managed by the legacy checker or an active watchlist.
                cursor.execute(
                    """
                    SELECT id, course_id FROM Sections
                    WHERE term = %s AND crn = %s
                    FOR UPDATE
                    """,
                    (term, crn),
                )
                existing = cursor.fetchone()

                if existing is None:
                    cursor.execute(
                        """
                        INSERT INTO Sections (
                            course_id, subject, term, crn, section_number,
                            capacity, enrolled, status, last_checked_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, NOW())
                        """,
                        (
                            course_id, course_subject, term, crn,
                            section["section"], section["max_enrollment"],
                            section["current_enrollment"], section["status"],
                        ),
                    )
                    continue

                section_id, previous_course_id = existing
                cursor.execute(
                    """
                    SELECT EXISTS(
                        SELECT 1 FROM Watchlists WHERE section_id = %s
                    )
                    """,
                    (section_id,),
                )
                has_watchers = bool(cursor.fetchone()[0])

                if previous_course_id is None or has_watchers:
                    # Keep the previous snapshot so the notification checker
                    # can detect changes itself. Preserve legacy NULL links.
                    cursor.execute(
                        """
                        UPDATE Sections
                        SET section_number = %s,
                            course_id = %s
                        WHERE id = %s
                        """,
                        (
                            section["section"],
                            previous_course_id if previous_course_id is None else course_id,
                            section_id,
                        ),
                    )
                else:
                    cursor.execute(
                        """
                        UPDATE Sections
                        SET course_id = %s,
                            section_number = %s,
                            capacity = %s,
                            enrolled = %s,
                            status = %s,
                            last_checked_at = NOW()
                        WHERE id = %s
                        """,
                        (
                            course_id, section["section"],
                            section["max_enrollment"],
                            section["current_enrollment"],
                            section["status"], section_id,
                        ),
                    )

            cursor.execute(
                """
                INSERT INTO DepartmentSyncs (subject, term, last_synced_at)
                VALUES (%s, %s, NOW())
                ON DUPLICATE KEY UPDATE last_synced_at = NOW()
                """,
                (subject, term),
            )

        connection.commit()

    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()

    print(
        f"Synchronized {len(course_ids)} courses and "
        f"{len(sections)} sections for {subject} {term}"
    )


if __name__ == "__main__":
    sync_department("IT", "202710")
