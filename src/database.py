import os
import pymysql


def get_connection():
    """Create a connection to MariaDB."""
    return pymysql.connect(
        host=os.environ["DB_HOST"],
        port=int(os.environ.get("DB_PORT", "3306")),
        user=os.environ["DB_USER"],
        password=os.environ["DB_PASSWORD"],
        database=os.environ["DB_NAME"],
        charset="utf8mb4",
        connect_timeout=10,
    )


def test_connection():
    """Verify that the database is accessible."""
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT DATABASE(), VERSION()")
            database, version = cursor.fetchone()

            print(f"Connected to database: {database}")
            print(f"MariaDB version: {version}")

    finally:
        connection.close()


if __name__ == "__main__":
    test_connection()



def save_section(subject, term, section):
    """Insert or update a section's latest enrollment data."""
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO Sections (
                    subject,
                    term,
                    crn,
                    section_number,
                    capacity,
                    enrolled,
                    status,
                    last_checked_at
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
                ON DUPLICATE KEY UPDATE
                    section_number = VALUES(section_number),
                    capacity = VALUES(capacity),
                    enrolled = VALUES(enrolled),
                    status = VALUES(status),
                    last_checked_at = NOW()
                """,
                (
                    subject,
                    term,
                    section["crn"],
                    section["section"],
                    section["max_enrollment"],
                    section["current_enrollment"],
                    section["status"],
                ),
            )

        connection.commit()

    finally:
        connection.close()


def get_sections_to_check():
    """Retrieve sections configured for monitoring."""
    connection = get_connection()

    try:
        with connection.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute(
                """
                    SELECT
                        s.id,
                        s.subject,
                        s.term,
                        s.crn,
                        s.section_number,
                        s.status,
                        s.last_checked_at
                    FROM Sections s
                    WHERE s.course_id IS NULL
                    OR EXISTS (
                        SELECT 1
                        FROM Watchlists w
                        WHERE w.section_id = s.id
                    )
                    ORDER BY s.term, s.subject, s.crn
                    """
            )
            return cursor.fetchall()

    finally:
        connection.close()


def search_cached_courses(subject, course_number, term):
    """Search cached course sections in MariaDB."""
    connection = get_connection()

    try:
        with connection.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute(
                """
                SELECT
                    c.subject,
                    c.course_number,
                    c.title,
                    s.id AS section_id,
                    s.term,
                    s.crn,
                    s.section_number,
                    s.capacity,
                    s.enrolled,
                    s.status,
                    s.last_checked_at
                FROM Courses c
                INNER JOIN Sections s
                    ON s.course_id = c.id
                WHERE c.subject = %s
                  AND c.course_number = %s
                  AND s.term = %s
                ORDER BY s.section_number
                """,
                (subject.upper(), str(course_number).upper(), term),
            )

            return cursor.fetchall()

    finally:
        connection.close()
        
        
def is_department_cache_fresh(subject, term, max_age=1800):
    """Check whether a department cache is still fresh."""
    connection = get_connection()

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT
                    last_synced_at >=
                    NOW() - INTERVAL %s SECOND
                FROM DepartmentSyncs
                WHERE subject = %s AND term = %s
                """,
                (max_age, subject.strip().upper(), str(term)),
            )

            result = cursor.fetchone()

            return bool(result and result[0])

    finally:
        connection.close()
        

def get_active_departments():
    """Retrieve departments and terms with active watchlists."""
    connection = get_connection()

    try:
        with connection.cursor(pymysql.cursors.DictCursor) as cursor:
            cursor.execute(
                """
                SELECT DISTINCT
                    s.subject,
                    s.term
                FROM Sections s
                INNER JOIN Watchlists w
                    ON w.section_id = s.id
                ORDER BY s.term, s.subject
                """
            )

            return cursor.fetchall()

    finally:
        connection.close()