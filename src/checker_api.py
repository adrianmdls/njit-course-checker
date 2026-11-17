"""Submit normalized Banner snapshots to the Express backend."""

import os

import requests


def submit_department_snapshot(subject, term, sections):
    """Send one snapshot; callers must not hold a department database lock."""
    api_url = os.getenv("CHECKER_API_URL", "").rstrip("/")
    token = os.getenv("CHECKER_API_TOKEN", "")
    if not api_url or not token:
        raise ValueError("Set CHECKER_API_URL and CHECKER_API_TOKEN for department synchronization.")

    try:
        response = requests.post(
            f"{api_url}/api/internal/sync/department",
            json={"subject": subject, "term": term, "sections": sections},
            headers={"Authorization": f"Bearer {token}"},
            timeout=(5, 30),
            allow_redirects=False,
        )
        response.raise_for_status()
    except requests.HTTPError as error:
        status = error.response.status_code
        message = "Department synchronization failed"
        if status in (401, 403):
            message = "Department synchronization authentication failed; check CHECKER_API_TOKEN"
        raise requests.HTTPError(f"{message} (HTTP {status}).") from None
    except requests.RequestException:
        # Do not log request headers, response bodies, or exceptions containing URLs.
        raise requests.RequestException(
            "Could not reach the department synchronization backend; check CHECKER_API_URL and connectivity."
        ) from None

    if not 200 <= response.status_code < 300:
        raise requests.RequestException(
            f"Department synchronization returned HTTP {response.status_code}; redirects are not followed."
        )
    try:
        return response.json()
    except ValueError:
        raise requests.RequestException("Department synchronization backend returned invalid JSON.") from None
