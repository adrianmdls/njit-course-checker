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
                    id,
                    subject,
                    term,
                    crn,
                    section_number
                FROM Sections
                ORDER BY term, subject, crn
                """
            )

            return cursor.fetchall()

    finally:
        connection.close()
