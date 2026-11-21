import os
import traceback
import unittest
from unittest.mock import patch

import requests

from src.checker_api import get_monitoring_targets, submit_department_snapshot
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
        post_patch = patch("src.checker_api.requests.request")
        self.post = post_patch.start()
        self.addCleanup(post_patch.stop)
        self.response = self.post.return_value
        self.response.status_code = 200
        self.response.json.return_value = COUNTS
        self.sections = parse_all_sections(BANNER)

    def test_success_sends_exact_contract_and_bearer_token(self):
        self.assertEqual(submit_department_snapshot("IT", "202795", self.sections), COUNTS)
        self.post.assert_called_once_with(
            "POST", "http://backend:3000/api/internal/sync/department",
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

    def test_validation_diagnostics_are_structured_and_allowlisted(self):
        self.response.status_code = 400
        self.response.raise_for_status.side_effect = requests.HTTPError("unsafe test-secret-token", response=self.response)
        diagnostic = {"field": "crn", "row_index": 1, "reason": "conflicting_crn"}
        self.response.json.return_value = {"error": "test-secret-token", "validation": {
            **diagnostic, "raw": "test-secret-token"}}
        with self.assertRaises(requests.HTTPError) as caught:
            submit_department_snapshot("DS", "202710", self.sections)
        self.assertEqual(caught.exception.validation, diagnostic)
        self.assertIn("conflicting_crn", str(caught.exception))
        self.assertNotIn("test-secret-token", "".join(traceback.format_exception(caught.exception)))
        for value in ({"field": "title", "reason": "test-secret-token", "row_index": 0},
                      {"field": [], "reason": "invalid_title"},
                      {**diagnostic, "row_index": True}, {**diagnostic, "row_index": 10000},
                      None, "test-secret-token"):
            self.response.json.return_value = {"validation": value}
            with self.subTest(value=value), self.assertRaises(requests.HTTPError) as caught:
                submit_department_snapshot("DS", "202710", self.sections)
            self.assertIsNone(caught.exception.validation)
            self.assertNotIn("test-secret-token", str(caught.exception))

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

    def test_retrieves_monitoring_targets(self):
        targets = [{"subject": "IT", "term": "202795"}]
        self.response.json.return_value = {"targets": targets}
        self.assertEqual(get_monitoring_targets(), targets)
        self.post.assert_called_once_with(
            "GET", "http://backend:3000/api/internal/sync/targets", json=None,
            headers={"Authorization": "Bearer test-secret-token"},
            timeout=(5, 30), allow_redirects=False,
        )

    def test_watched_only_uses_existing_endpoint_with_explicit_filter(self):
        self.response.json.return_value = {"targets": []}
        self.assertEqual(get_monitoring_targets(watched_only=True), [])
        self.assertEqual(self.post.call_args.args[:2],
                         ("GET", "http://backend:3000/api/internal/sync/targets?watched_only=true"))

    def test_invalid_monitoring_response(self):
        for body in (None, {}, {"targets": None}, {"targets": [{}]}):
            with self.subTest(body=body):
                self.response.json.return_value = body
                with self.assertRaisesRegex(requests.RequestException, "invalid targets"):
                    get_monitoring_targets()


if __name__ == "__main__":
    unittest.main()
