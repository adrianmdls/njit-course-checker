import os
import unittest
from unittest.mock import patch

import requests

from src import checker


TARGETS = [{"subject": "IT", "term": "202795"}, {"subject": "CS", "term": "202710"}]
SECTIONS = [{"course": "IT 490", "title": "Special Topics - AI", "crn": "54321",
             "section": "H01", "status": "OPEN", "max_enrollment": 30, "current_enrollment": 20}]
COUNTS = {"courses": 1, "sections": 1, "status_changes": 0}


class CheckerTests(unittest.TestCase):
    def test_no_targets_does_not_fetch_or_submit(self):
        with patch.object(checker, "get_monitoring_targets", return_value=[]), \
             patch.object(checker, "get_sections") as fetch, \
             patch.object(checker, "submit_department_snapshot") as submit:
            results, errors, term = checker.check_once()
        self.assertIn("No departments", results[0])
        self.assertEqual((errors, term), (0, None))
        fetch.assert_not_called()
        submit.assert_not_called()

    def test_sequential_polling_without_database_credentials(self):
        calls = []

        def fetch(subject, term):
            calls.append(("fetch", subject, term))
            return subject

        def parse(data):
            calls.append(("parse", data))
            return SECTIONS

        def submit(subject, term, sections):
            self.assertIs(sections, SECTIONS)
            calls.append(("submit", subject, term))
            return COUNTS

        with patch.dict(os.environ, {}, clear=True), \
             patch.object(checker, "get_monitoring_targets", return_value=TARGETS), \
             patch.object(checker, "get_sections", side_effect=fetch), \
             patch.object(checker, "parse_all_sections", side_effect=parse), \
             patch.object(checker, "submit_department_snapshot", side_effect=submit):
            results, errors, term = checker.check_once()
        self.assertEqual(calls, [
            ("fetch", "IT", "202795"), ("parse", "IT"), ("submit", "IT", "202795"),
            ("fetch", "CS", "202710"), ("parse", "CS"), ("submit", "CS", "202710"),
        ])
        self.assertEqual((len(results), errors, term), (2, 0, None))

    def test_target_api_failure_stops_cycle(self):
        with patch.object(checker, "get_monitoring_targets", side_effect=requests.HTTPError("HTTP 503")), \
             patch.object(checker, "get_sections") as fetch, self.assertLogs(checker.logger):
            results, errors, _ = checker.check_once()
        self.assertEqual(errors, 1)
        self.assertIn("Could not load monitoring targets", results[0])
        fetch.assert_not_called()

    def test_banner_failure_does_not_submit_and_next_target_continues(self):
        with patch.object(checker, "get_monitoring_targets", return_value=TARGETS), \
             patch.object(checker, "get_sections", side_effect=[requests.ConnectionError("Banner unavailable"), []]), \
             patch.object(checker, "parse_all_sections", return_value=SECTIONS), \
             patch.object(checker, "submit_department_snapshot", return_value=COUNTS) as submit, \
             self.assertLogs(checker.logger):
            results, errors, _ = checker.check_once()
        self.assertEqual((len(results), errors), (2, 1))
        submit.assert_called_once_with("CS", "202710", SECTIONS)

    def test_valid_empty_snapshot_is_submitted(self):
        with patch.object(checker, "get_monitoring_targets", return_value=TARGETS[:1]), \
             patch.object(checker, "get_sections", return_value=[]), \
             patch.object(checker, "submit_department_snapshot", return_value={
                 "courses": 0, "sections": 0, "status_changes": 0}) as submit:
            _, errors, _ = checker.check_once()
        self.assertEqual(errors, 0)
        submit.assert_called_once_with("IT", "202795", [])

    def test_malformed_snapshot_is_not_submitted(self):
        for data in ({}, [{"SECTIONS_TABLE": "<p>upstream failure</p>"}]):
            with self.subTest(data=data), \
                 patch.object(checker, "get_monitoring_targets", return_value=TARGETS[:1]), \
                 patch.object(checker, "get_sections", return_value=data), \
                 patch.object(checker, "submit_department_snapshot") as submit, \
                 self.assertLogs(checker.logger):
                _, errors, _ = checker.check_once()
                self.assertEqual(errors, 1)
                submit.assert_not_called()

    def test_submission_failure_is_logged_and_next_target_continues(self):
        with patch.object(checker, "get_monitoring_targets", return_value=TARGETS), \
             patch.object(checker, "get_sections", return_value=[]), \
             patch.object(checker, "parse_all_sections", return_value=SECTIONS), \
             patch.object(checker, "submit_department_snapshot", side_effect=[requests.HTTPError("HTTP 503"), COUNTS]) as submit, \
             self.assertLogs(checker.logger) as logs:
            results, errors, _ = checker.check_once()
        self.assertEqual((len(results), errors, submit.call_count), (2, 1, 2))
        self.assertTrue(any("Department check failed for IT 202795" in line for line in logs.output))

    def test_manual_check_never_submits(self):
        with patch.object(checker, "get_monitoring_targets", return_value=TARGETS[:1]), \
             patch.object(checker, "get_sections", return_value=[]), \
             patch.object(checker, "parse_all_sections", return_value=SECTIONS), \
             patch.object(checker, "submit_department_snapshot") as submit:
            results, errors, term = checker.check_once(persist_state=False)
        self.assertIn("read-only", results[0])
        self.assertEqual((errors, term), (0, "202795"))
        submit.assert_not_called()

    def test_interval_validation_is_preserved(self):
        for interval in ("0", "-1", "invalid"):
            with self.subTest(interval=interval), patch.dict(os.environ, {"CHECK_INTERVAL": interval}), \
                 patch.object(checker, "setup_logging"), patch("builtins.print"), self.assertLogs(checker.logger):
                self.assertEqual(checker.main(), 1)

    def test_interval_waits_after_completed_cycle(self):
        for environment, expected in (({}, 600), ({"CHECK_INTERVAL": "15"}, 15)):
            with self.subTest(environment=environment), patch.dict(os.environ, environment, clear=True), \
                 patch.object(checker, "setup_logging"), \
                 patch.object(checker, "check_once", return_value=(["No departments"], 0, None)) as check, \
                 patch.object(checker, "print_results"), patch("builtins.print"), \
                 patch.object(checker.time, "sleep", side_effect=KeyboardInterrupt) as sleep:
                self.assertEqual(checker.main(), 0)
            check.assert_called_once_with()
            sleep.assert_called_once_with(expected)


if __name__ == "__main__":
    unittest.main()
