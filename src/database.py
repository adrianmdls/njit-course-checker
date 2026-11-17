"""Legacy SQL cache reads for the standalone course_search helper only."""

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
