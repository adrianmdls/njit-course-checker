import os
import traceback
import unittest
from contextlib import contextmanager
from unittest.mock import Mock, patch

import requests

from src.checker_api import submit_department_snapshot
from src.department_sync import sync_department
from src.njit_scraper import parse_all_sections


CELLS = ["H01", "12345", "M", "10:00", "CKB", "OPEN", "30", "20",
         "Instructor", "In Person", "3", "", ""]
BANNER = [{"SECTIONS_TABLE": '<h4 id="IT 490">Special Topics - AI</h4>'
           '<table class="sections-table"><tr>'
           + "".join(f"<td>{value}</td>" for value in CELLS) + "</tr></table>"}]
COUNTS = {"courses": 1, "sections": 1, "status_changes": 0}


class CheckerAPITests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "CHECKER_API_URL": "http://backend:3000/",
            "CHECKER_API_TOKEN": "test-secret-token",
        }, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        post_patch = patch("src.checker_api.requests.post")
        self.post = post_patch.start()
        self.addCleanup(post_patch.stop)
        self.response = self.post.return_value
        self.response.status_code = 200
        self.response.json.return_value = COUNTS
        self.sections = parse_all_sections(BANNER)

    def test_success_sends_exact_contract_and_bearer_token(self):
        self.assertEqual(submit_department_snapshot("IT", "202795", self.sections), COUNTS)
        self.post.assert_called_once_with(
            "http://backend:3000/api/internal/sync/department",
            json={"subject": "IT", "term": "202795", "sections": self.sections},
            headers={"Authorization": "Bearer test-secret-token"},
            timeout=(5, 30), allow_redirects=False,
        )
        self.response.raise_for_status.assert_called_once_with()
        self.assertEqual(self.sections[0]["title"], "Special Topics - AI")

    def test_missing_configuration_fails_before_request(self):
        for name in ("CHECKER_API_URL", "CHECKER_API_TOKEN"):
            with self.subTest(name=name), patch.dict(os.environ, {name: ""}):
                with self.assertRaisesRegex(ValueError, name):
                    submit_department_snapshot("IT", "202795", self.sections)
        self.post.assert_not_called()

    def test_invalid_credentials_and_backend_errors_do_not_expose_secrets(self):
        for status in (401, 403, 409, 500, 503):
            with self.subTest(status=status):
                self.response.status_code = status
                self.response.raise_for_status.side_effect = requests.HTTPError(
                    "unsafe test-secret-token", response=self.response)
                with self.assertRaises(requests.HTTPError) as caught:
                    submit_department_snapshot("IT", "202795", self.sections)
                self.assertIn(f"HTTP {status}", str(caught.exception))
                if status in (401, 403):
                    self.assertIn("authentication failed", str(caught.exception))
                self.assertNotIn("test-secret-token", "".join(traceback.format_exception(caught.exception)))

    def test_connection_failure_and_timeout_have_safe_messages(self):
        for error in (requests.ConnectionError, requests.Timeout):
            with self.subTest(error=error):
                self.post.side_effect = error("unsafe test-secret-token")
                with self.assertRaisesRegex(requests.RequestException, "Could not reach") as caught:
                    submit_department_snapshot("IT", "202795", self.sections)
                self.assertNotIn("test-secret-token", "".join(traceback.format_exception(caught.exception)))

    def test_redirect_is_rejected(self):
        self.response.status_code = 307
        with self.assertRaisesRegex(requests.RequestException, "redirects are not followed"):
            submit_department_snapshot("IT", "202795", self.sections)
        self.response.json.assert_not_called()

    def test_invalid_json_response_has_safe_message(self):
        self.response.json.side_effect = ValueError("unsafe test-secret-token")
        with self.assertRaisesRegex(requests.RequestException, "invalid JSON") as caught:
            submit_department_snapshot("IT", "202795", self.sections)
        self.assertNotIn("test-secret-token", "".join(traceback.format_exception(caught.exception)))


class DepartmentSyncTests(unittest.TestCase):
    @patch("builtins.print")
    @patch("src.department_sync.submit_department_snapshot", return_value=COUNTS)
    @patch("src.department_sync.get_sections", return_value=BANNER)
    def test_fetches_parses_and_submits_without_database(self, fetch, submit, output):
        with patch("src.database.get_connection", side_effect=AssertionError("No database writes")):
            self.assertIsNone(sync_department(" it ", 202795))
        fetch.assert_called_once_with("IT", "202795")
        submit.assert_called_once_with("IT", "202795", parse_all_sections(BANNER))
        output.assert_called_once_with("Synchronized 1 courses and 1 sections for IT 202795")

    @patch("builtins.print")
    @patch("src.department_sync.submit_department_snapshot", return_value=COUNTS)
    @patch("src.department_sync.get_sections")
    def test_reuses_supplied_banner_data(self, fetch, submit, output):
        sync_department("IT", "202795", data=BANNER)
        fetch.assert_not_called()
        submit.assert_called_once_with("IT", "202795", parse_all_sections(BANNER))

    @patch("src.department_sync.submit_department_snapshot")
    def test_empty_snapshot_is_not_submitted(self, submit):
        with self.assertRaisesRegex(ValueError, "No sections found"):
            sync_department("IT", "202795", data=[])
        submit.assert_not_called()

    def test_checker_submits_after_releasing_legacy_lock(self):
        from src import checker

        held = False

        @contextmanager
        def lock(*args, **kwargs):
            nonlocal held
            held = True
            try:
                yield
            finally:
                held = False

        def submit(*args, **kwargs):
            self.assertFalse(held, "Express must be able to acquire the department lock")

        monitored = [{"id": 1, "subject": "IT", "term": "202795", "crn": "12345",
                      "section_number": "H01", "status": "OPEN"}]
        with patch.object(checker, "get_sections_to_check", return_value=monitored), \
             patch.object(checker, "department_lock", side_effect=lock), \
             patch.object(checker, "get_sections", return_value=BANNER), \
             patch.object(checker, "save_section"), \
             patch.object(checker, "send_discord_notification"), \
             patch.object(checker, "sync_department", side_effect=submit) as sync:
            _, errors, _ = checker.check_once()
        self.assertEqual(errors, 0)
        sync.assert_called_once_with("IT", "202795", data=BANNER)

    def test_existing_search_helper_submits_without_database_lock(self):
        from src import course_search

        with patch("src.database.get_connection", side_effect=AssertionError("No database lock")), \
             patch.object(course_search, "is_department_cache_fresh", return_value=False), \
             patch.object(course_search, "search_cached_courses", return_value=[{"section_id": 1}]), \
             patch.object(course_search, "sync_department") as sync:
            result = course_search.search_courses("IT", "490", "202795")
        sync.assert_called_once_with("IT", "202795")
        self.assertEqual(result["source"], "banner")


if __name__ == "__main__":
    unittest.main()
