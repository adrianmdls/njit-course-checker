from src.njit_scraper import get_sections, parse_all_sections
from src.database import get_connection


def sync_department(subject, term):
    """Synchronize a department's courses and sections."""
    subject = subject.strip().upper()

    data = get_sections(subject, term)
    sections = parse_all_sections(data)

    if not sections:
        raise ValueError("No sections found. Skipping synchronization.")

    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            course_ids = {}

            for section in sections:
                course = section["course"]
                course_subject, course_number = course.split(maxsplit=1)
                title = section["title"].split(" - ", 1)[-1]

                key = (course_subject, course_number)

                if key not in course_ids:
                    cursor.execute(
                        """
                        INSERT INTO Courses (
                            subject, course_number, title
                        )
                        VALUES (%s, %s, %s)
                        ON DUPLICATE KEY UPDATE
                            title = VALUES(title)
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

                cursor.execute(
                    """
                    INSERT INTO Sections (
                        course_id, subject, term, crn,
                        section_number, capacity, enrolled,
                        status, last_checked_at
                    )
                    VALUES (
                        %s, %s, %s, %s,
                        %s, %s, %s, %s, NOW()
                    )
                    ON DUPLICATE KEY UPDATE
                        course_id = VALUES(course_id),
                        section_number = VALUES(section_number),
                        capacity = VALUES(capacity),
                        enrolled = VALUES(enrolled),
                        status = VALUES(status),
                        last_checked_at = NOW()
                    """,
                    (
                        course_id,
                        course_subject,
                        term,
                        section["crn"],
                        section["section"],
                        section["max_enrollment"],
                        section["current_enrollment"],
                        section["status"],
                    ),
                )

            cursor.execute(
                """
                INSERT INTO DepartmentSyncs (
                    subject, term, last_synced_at
                )
                VALUES (%s, %s, NOW())
                ON DUPLICATE KEY UPDATE
                    last_synced_at = NOW()
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