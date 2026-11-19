"""Offline checks of the disposable probe; no Docker, HTTP or SQL."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

import requests


def load_probe_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).parent / "integration" / filename)
    module = importlib.util.module_from_spec(spec)
    # checker_probe installs a SQL import guard for its separate container process.
    # Keep that guard and its /workspace path out of this unit-test process.
    with patch.object(sys, "meta_path", list(sys.meta_path)), patch.object(sys, "path", list(sys.path)):
        spec.loader.exec_module(module)
    return module


pipeline = load_probe_module("probe_pipeline", "test_pipeline.py")
probe = load_probe_module("checker_probe_auth", "checker_probe.py")


class ScheduledBatchTests(unittest.TestCase):
    def test_batch_observes_a_sanitized_submission_failure_and_continues(self):
        def response(status, body):
            result = requests.Response()
            result.status_code = status
            result.url = "http://test.invalid/private-fixture-url"
            result._content = json.dumps(body).encode()
            return result

        targets = response(200, {"targets": [
            {"subject": subject, "term": term} for subject, term in pipeline.WATCHED_PAIRS
        ]})
        failure = response(503, {"error": "private fixture response"})
        counts = {"courses": 2, "sections": 2, "status_changes": 0}
        handlers = list(probe.checker.logger.handlers)
        responses = [targets, targets, failure, targets, response(200, counts)]
        with (
            patch.dict(os.environ, {"CHECKER_API_URL": "http://test.invalid", "CHECKER_API_TOKEN": "test-token"}, clear=True),
            patch.object(requests, "request", side_effect=responses) as http,
        ):
            result = probe.run({"mode": "scheduled_batch"})
        self.assertEqual(probe.checker.logger.handlers, handlers)
        self.assertEqual(result["banner_calls"], pipeline.WATCHED_PAIRS)
        self.assertEqual(result["submit_attempts"], pipeline.WATCHED_PAIRS)
        self.assertEqual(result["submissions"], [{"subject": "IT", "term": "202795", **counts}])
        self.assertEqual(result["errors"], [
            "watched synchronization failed for CS 202710: Department synchronization failed (HTTP 503)."
        ])
        posts = [call.kwargs["json"] for call in http.call_args_list if call.args[0] == "POST"]
        self.assertEqual([(post["subject"], post["term"]) for post in posts],
                         [tuple(pair) for pair in pipeline.WATCHED_PAIRS])
        self.assertEqual([[section["crn"] for section in post["sections"]] for post in posts],
                         [["12345", "12346"], ["54321", "54322"]])


class ProbeAuthenticationTests(unittest.TestCase):
    def test_spring_fixture_has_distinct_section_titles_and_a_stable_lowest_crn(self):
        sections = probe.parse_all_sections(probe.banner("CS", section_count=53, mixed=True,
                                                        title_variants=True, vary_enrollment=True))
        self.assertEqual(len(sections), 53)
        self.assertEqual(len({row["crn"] for row in sections}), 53)
        self.assertEqual(len({row["title"] for row in sections}), 53)
        self.assertEqual({row["course"] for row in sections}, {"CS 100"})
        self.assertEqual({row["status"] for row in sections}, {"OPEN", "CLOSED", "CANCELLED"})
        self.assertEqual({row["current_enrollment"] for row in sections}, {20, 21, 22})
        self.assertEqual(min(sections, key=lambda row: row["crn"])["title"], "CS 100 - Introduction")

    def make_pipeline(self):
        case = pipeline.PipelineTests("test_watched_targets_deduplicate_and_demote")
        case.sql = Mock()
        case.setUp()
        payloads = []

        def command(*args, input):
            payload = json.loads(input)
            payloads.append(payload)
            return json.dumps({"cookies": {"njit.sid": "signed-test-cookie"}}
                              if payload["mode"] == "authenticate" else {"ok": True})

        case.command = Mock(side_effect=command)
        return case, payloads

    def test_repeated_authenticated_reads_share_one_real_authentication_setup(self):
        case, payloads = self.make_pipeline()
        for mode in ("search", "options", "watchlist", "search", "watchlist", "search"):
            case.probe(mode)
        self.assertEqual([p["mode"] for p in payloads].count("authenticate"), 1)
        for payload in payloads[1:]:
            self.assertEqual(payload["session_cookies"], {"njit.sid": "signed-test-cookie"})

    def test_unauthenticated_reads_never_authenticate_or_reuse_the_cached_cookie(self):
        case, payloads = self.make_pipeline()
        case.probe("search")
        for mode in ("search", "options", "watchlist"):
            case.probe(mode, authenticated=False)
            self.assertNotIn("session_cookies", payloads[-1])
        self.assertEqual([p["mode"] for p in payloads].count("authenticate"), 1)

    def test_database_reset_also_discards_the_session_cache(self):
        case, payloads = self.make_pipeline()
        case.probe("search")
        case.setUp()
        case.probe("search")
        self.assertEqual([p["mode"] for p in payloads].count("authenticate"), 2)

    def test_authenticate_uses_real_routes_and_returns_the_session_cookie(self):
        with patch.dict(os.environ, {"APP_ORIGIN": "http://test.invalid"}, clear=True), \
             patch.object(probe.requests, "Session") as session_factory:
            session = session_factory.return_value.__enter__.return_value
            session.cookies = requests.cookies.RequestsCookieJar()
            session.cookies.set("njit.sid", "signed-test-cookie")
            registered, logged_in = Mock(status_code=201), Mock(status_code=200)
            session.post.side_effect = [registered, logged_in]
            self.assertEqual(probe.run({"mode": "authenticate"}),
                             {"cookies": {"njit.sid": "signed-test-cookie"}})
            self.assertEqual([call.args[0] for call in session.post.call_args_list],
                             ["http://frontend/api/auth/register", "http://frontend/api/auth/login"])
            logged_in.raise_for_status.assert_called_once_with()
            session.get.assert_not_called()

    def test_read_probe_uses_the_cookie_without_repeating_registration_or_login(self):
        with patch.dict(os.environ, {}, clear=True), patch.object(probe.requests, "Session") as session_factory:
            session = session_factory.return_value.__enter__.return_value
            session.cookies = requests.cookies.RequestsCookieJar()
            session.get.return_value = Mock(status_code=200)
            session.get.return_value.json.return_value = {"sections": []}
            self.assertEqual(probe.run({"mode": "watchlist", "session_cookies": {"njit.sid": "signed-test-cookie"}}),
                             {"status": 200, "body": {"sections": []}})
            self.assertEqual(session.cookies.get("njit.sid"), "signed-test-cookie")
            session.post.assert_not_called()
            session.get.assert_called_once_with("http://frontend/api/watchlist", timeout=10)

    def test_expired_browser_fixture_can_log_in_again_without_registration(self):
        with patch.dict(os.environ, {"APP_ORIGIN": "http://test.invalid"}, clear=True), \
             patch.object(probe.requests, "Session") as session_factory:
            session = session_factory.return_value.__enter__.return_value
            session.cookies = requests.cookies.RequestsCookieJar()
            session.cookies.set("njit.sid", "renewed-signed-cookie")
            self.assertEqual(probe.run({"mode": "authenticate", "register": False}),
                             {"cookies": {"njit.sid": "renewed-signed-cookie"}})
            self.assertEqual(session.post.call_count, 1)
            self.assertEqual(session.post.call_args.args[0], "http://frontend/api/auth/login")
            session.post.return_value.raise_for_status.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
