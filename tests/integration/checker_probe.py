"""One-shot checker-side probe; only Banner I/O is replaced with fixture data."""

import contextlib
import importlib.abc
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
from unittest.mock import patch


class RejectDatabaseImports(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname in ("pymysql", "src.database", "src.sync_lock"):
            raise AssertionError(f"Checker imported a database module: {fullname}")


sys.path.insert(0, "/workspace")
sys.meta_path.insert(0, RejectDatabaseImports())

import requests
from src import checker, manual_check
from src.checker_api import get_monitoring_targets, submit_department_snapshot
from src.njit_scraper import parse_all_sections

FIXTURES = json.loads((Path(__file__).resolve().parents[1] / "fixtures/banner-snapshots.json").read_text())


def banner(subject, status="OPEN", enrolled=20, section_count=None, mixed=False):
    courses = [("100", "12345", "001"), ("100", "12346", "H01")] if subject == "CS" else [
        ("101", "54321", "001"), ("490", "54322", "H01")]
    if section_count and subject == "CS":
        courses = [("100", str(12000 + index), f"{index:03}") for index in range(section_count)]
    tables = []
    for index, (number, crn, section) in enumerate(courses):
        stored_status = ["OPEN", "CLOSED", "CANCELLED"][index % 3] if mixed else status
        title = "Special Topics - AI" if number == "490" else f"{subject} {number} - Introduction"
        cells = [section, crn, "M", "10:00", "CKB", stored_status, "30", str(enrolled),
                 "Instructor", "In Person", "3", "", ""]
        tables.append(f'<h4 id="{subject} {number}">{title}</h4><table class="sections-table"><tr>'
                      + "".join(f"<td>{value}</td>" for value in cells) + "</tr></table>")
    return [{"SECTIONS_TABLE": "".join(tables)}]


def run(options):
    assert not any(name.startswith("DB_") for name in os.environ), "Checker has DB credentials"
    mode = options["mode"]
    if mode == "network":
        for host in ("db", options["database_ip"]):
            try:
                connection = socket.create_connection((host, 3306), timeout=1)
            except OSError:
                continue
            connection.close()
            raise AssertionError("Checker can connect directly to MariaDB")
        return {"database_access": False}
    if options.get("invalid_token"):
        os.environ["CHECKER_API_TOKEN"] = "invalid-integration-token"
    try:
        if mode in ("authenticate", "search", "options", "watchlist"):
            # Exercise Nginx, real login and cookie reuse; no Banner helper is called.
            with requests.Session() as session:
                if mode == "authenticate":
                    headers = {"Origin": os.environ["APP_ORIGIN"],
                               "X-Requested-With": "NJIT-Course-Checker"}
                    credentials = {"username": "course_search_fixture", "email": "search@example.invalid",
                                   "password": "integration-only-search-password"}
                    response = session.post("http://frontend/api/auth/register", json=credentials, headers=headers, timeout=10)
                    assert response.status_code in (201, 409), response.text
                    response = session.post("http://frontend/api/auth/login", json={
                        "identifier": credentials["username"], "password": credentials["password"]}, headers=headers, timeout=10)
                    response.raise_for_status()
                    return {"cookies": requests.utils.dict_from_cookiejar(session.cookies)}
                if options.get("authenticated", True):
                    session.cookies.update(options["session_cookies"])
                results = []
                if mode in ("options", "watchlist"):
                    path = "/api/courses/options" if mode == "options" else "/api/watchlist"
                    response = session.get(f"http://frontend{path}", timeout=10)
                    return {"status": response.status_code, "body": response.json()}
                for query in options["queries"]:
                    response = session.get("http://frontend/api/courses", params=query, timeout=10)
                    results.append({"status": response.status_code, "body": response.json()})
                return results
        if mode == "targets":
            return {"targets": get_monitoring_targets()}
        if mode == "submit":
            data = (FIXTURES[options["banner_fixture"]] if "banner_fixture" in options else
                    banner(options["subject"], options.get("status", "OPEN"), options.get("enrolled", 20),
                           options.get("section_count"), options.get("mixed", False)))
            sections = parse_all_sections(data)
            return submit_department_snapshot(options["subject"], options["term"], sections)
        calls = []

        def fetch(subject, term):
            calls.append([subject, term])
            if options.get("banner_failure"):
                raise requests.ConnectionError("Fixture Banner service unavailable")
            if "banner_fixture" in options:
                return FIXTURES[options["banner_fixture"]]
            return banner(subject, options.get("status", "OPEN"), options.get("enrolled", 20),
                          options.get("section_count"), options.get("mixed", False))

        with patch.object(checker, "get_sections", side_effect=fetch):
            if mode == "manual":
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    code = manual_check.main()
                return {"exit_code": code, "output": output.getvalue(), "banner_calls": calls}
            if mode == "scheduled":
                class Clock:
                    seconds = 0
                    def time(self):
                        return self.seconds
                    def monotonic(self):
                        return self.seconds
                    def wait(self, seconds):
                        self.seconds += seconds
                        return False
                clock = Clock()
                with tempfile.TemporaryDirectory() as directory:
                    departments = options["departments"]
                    cursor = checker.RotationCursor(Path(directory) / "rotation.json", departments)
                    scheduled = checker.ScheduledChecker(options["terms"], departments, cursor,
                                                          clock=clock, wait=clock.wait)
                    kind = options.get("kind", "regular")
                    slot = 300 if kind == "watched" else 0
                    clock.seconds = slot
                    scheduled.run_slot(kind, slot)
                    return {"banner_calls": calls, "next_subject": cursor.next_subject}
            if mode != "poll":
                raise ValueError("Unknown probe mode")
            results, errors, term = checker.check_once()
            return {"results": results, "errors": errors, "term": term, "banner_calls": calls}
    except requests.RequestException as error:
        message = str(error)
        assert "integration-only-checker-token" not in message
        assert "invalid-integration-token" not in message
        return {"error": message}


if __name__ == "__main__":
    print(json.dumps(run(json.load(sys.stdin))))
