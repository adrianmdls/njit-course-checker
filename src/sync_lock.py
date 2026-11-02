from contextlib import contextmanager

from src.database import get_connection


@contextmanager
def department_lock(subject, term, timeout=10):
    """Prevent simultaneous synchronization of a department and term."""

    subject = subject.strip().upper()
    term = str(term).strip()

    lock_name = f"njit:sync:{subject}:{term}"
    connection = get_connection()
    acquired = False

    try:
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT GET_LOCK(%s, %s)",
                (lock_name, timeout),
            )

            acquired = cursor.fetchone()[0] == 1

        if not acquired:
            raise TimeoutError(
                f"Could not acquire synchronization lock: {lock_name}"
            )

        yield

    finally:
        if acquired:
            try:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT RELEASE_LOCK(%s)",
                        (lock_name,),
                    )
            finally:
                connection.close()
        else:
            connection.close()