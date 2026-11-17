"""Submit normalized Banner snapshots to the Express backend."""

import os

import requests


def _request(method, path, payload=None):
    """Call an internal endpoint without exposing credentials in errors."""
    api_url = os.getenv("CHECKER_API_URL", "").rstrip("/")
    token = os.getenv("CHECKER_API_TOKEN", "")
    if not api_url or not token:
        raise ValueError("Set CHECKER_API_URL and CHECKER_API_TOKEN for department synchronization.")

    try:
        response = requests.request(
            method, f"{api_url}{path}",
            json=payload,
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


def submit_department_snapshot(subject, term, sections):
    """Send one snapshot; callers must not hold a department database lock."""
    return _request("POST", "/api/internal/sync/department", {
        "subject": subject, "term": term, "sections": sections,
    })


def get_monitoring_targets():
    """Retrieve unique monitored subject/term pairs from Express."""
    result = _request("GET", "/api/internal/sync/targets")
    try:
        targets = result["targets"]
        if not isinstance(targets, list) or any(
            not isinstance(target, dict)
            or not isinstance(target.get("subject"), str)
            or not isinstance(target.get("term"), str)
            for target in targets
        ):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise requests.RequestException("Monitoring backend returned invalid targets.") from None
    return targets
