"""Run explicitly: python3 -B tests/integration/test_pipeline.py (Docker required).

Only the randomly named disposable stack created here is inspected or changed.
Host Python uses the standard library; checker SQL inspection runs in the backend.
"""

import json
import os
from pathlib import Path
import subprocess
import socket
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "tests" / "integration" / "compose.yaml"
SQL = """const pool = require('./src/db');
pool.execute(process.argv[1], JSON.parse(process.argv[2]))
  .then(([rows]) => process.stdout.write(JSON.stringify(rows)))
  .catch(error => { console.error(error.code || 'SQL failed'); process.exitCode = 1; })
  .finally(() => pool.end());"""
WATCHED_PAIRS = [["CS", "202710"], ["IT", "202795"]]
INITIAL_COUNTS = [(1, 2, 1), (2, 2, 1)]


class PipelineTests(unittest.TestCase):
    @classmethod
    def command(cls, *args, input=None):
        result = subprocess.run(cls.compose + list(args), input=input, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600, env=cls.environment)
        if result.returncode:
            raise AssertionError(f"Docker command failed: {args[0]}\n{result.stdout}\n{result.stderr}")
        return result.stdout

    @classmethod
    def setUpClass(cls):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            cls.http_port = listener.getsockname()[1]
        cls.environment = dict(os.environ, INTEGRATION_HTTP_PORT=str(cls.http_port))
        cls.compose = ["docker", "compose", "--env-file", os.devnull,
                       "-p", f"njit-banner-test-{uuid.uuid4().hex[:10]}", "-f", str(COMPOSE)]
        cls.addClassCleanup(cls.cleanup)
        print("Building disposable integration stack...", flush=True)
        cls.command("build", "backend", "checker-test", "frontend")
        cls.command("up", "-d", "--wait", "--wait-timeout", "120", "frontend", "backend", "db")

    @classmethod
    def cleanup(cls):
        cls.command("down", "--volumes", "--remove-orphans")

    @classmethod
    def sql(cls, statement, params=None):
        return json.loads(cls.command("exec", "-T", "backend", "node", "-e", SQL,
                                      statement, json.dumps(params or [])))

    def probe(self, mode, **options):
        if mode in ("search", "options", "watchlist") and options.get("authenticated", True):
            # Real registration/login once per test; reuse the signed cookie
            # across one-shot probe containers instead of exhausting auth limits.
            if self.session_cookies is None:
                self.session_cookies = self.probe("authenticate")["cookies"]
            options["session_cookies"] = self.session_cookies
        return json.loads(self.command("run", "--rm", "--no-deps", "-T", "checker-test",
                                       input=json.dumps({"mode": mode, **options})))

    def verify_browser(self, empty=False):
        browser = subprocess.run(["node", str(ROOT / "tests/integration/course_search_browser.mjs"),
                                  f"http://127.0.0.1:{self.http_port}", "empty" if empty else "catalog"], text=True,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120,
                                 env=dict(os.environ, INTEGRATION_BACKEND_CONTAINER=self.command("ps", "-q", "backend").strip()))
        self.assertEqual(browser.returncode, 0, browser.stdout + browser.stderr)
        print(browser.stdout, flush=True)

    def setUp(self):
        self.session_cookies = None
        for table in ("Watchlists", "Sections", "Courses", "Users", "DepartmentSyncs", "sessions"):
            self.sql(f"DELETE FROM {table}")

    def seed_watchlists(self):
        self.sql("INSERT INTO Users (username,email,password_hash) VALUES (?,?,?),(?,?,?)",
                 ["fixture_one", "one@example.invalid", "unused", "fixture_two", "two@example.invalid", "unused"])
        users = self.sql("SELECT id FROM Users ORDER BY id")
        self.sql("INSERT INTO Sections (subject,term,crn,status) VALUES (?,?,?,?),(?,?,?,?),(?,?,?,?)",
                 ["CS", "202710", "12345", "CLOSED", "CS", "202710", "12346", "OPEN",
                  "IT", "202795", "54321", "CLOSED"])
        sections = self.sql("SELECT id,crn FROM Sections ORDER BY crn")
        ids = {row["crn"]: row["id"] for row in sections}
        self.sql("INSERT INTO Watchlists (user_id,section_id) VALUES (?,?),(?,?),(?,?),(?,?)",
                 [users[0]["id"], ids["12345"], users[0]["id"], ids["12346"],
                  users[1]["id"], ids["12345"], users[1]["id"], ids["54321"]])
        return sections, self.sql("SELECT * FROM Watchlists ORDER BY id")

    def scheduled_batch(self, expected_counts=None, **options):
        result = self.probe("scheduled_batch", **options)
        self.assertEqual(result["banner_calls"], WATCHED_PAIRS, result)
        if expected_counts is not None:
            self.assertEqual(result["errors"], [], result)
            self.assertEqual(result["submit_attempts"], WATCHED_PAIRS)
            submitted = result["submissions"]
            self.assertEqual([[row["subject"], row["term"]] for row in submitted], WATCHED_PAIRS)
            self.assertEqual([(row["courses"], row["sections"], row["status_changes"]) for row in submitted],
                             expected_counts)
        return result

    def snapshot(self):
        return {table: self.sql(f"SELECT * FROM {table} ORDER BY " +
                               ("subject,term" if table == "DepartmentSyncs" else "id"))
                for table in ("Courses", "Sections", "Watchlists", "DepartmentSyncs")}

    def age_timestamps(self):
        # A mistaken refresh must remain visible even when requests run in the same second.
        self.sql("UPDATE Sections SET last_checked_at = ?", ["2000-01-01 00:00:00"])
        self.sql("UPDATE DepartmentSyncs SET last_synced_at = ?", ["2000-01-01 00:00:00"])

    def test_watched_targets_deduplicate_and_demote(self):
        def assert_targets(pairs):
            expected = {"targets": [{"subject": subject, "term": term} for subject, term in pairs]}
            for watched_only in (False, True):
                self.assertEqual(self.probe("targets", watched_only=watched_only), expected)

        self.assertEqual(self.probe("submit", subject="CS", term="202790", section_count=1)["sections"], 1)
        self.sql("INSERT INTO Sections (subject,term,crn) VALUES ('ECE','202795','98765')")
        assert_targets([])
        self.seed_watchlists()
        self.sql("UPDATE Sections SET is_active=FALSE WHERE subject='IT' AND term='202795'")
        self.age_timestamps()
        before = self.snapshot()
        assert_targets(WATCHED_PAIRS)
        self.assertEqual(self.snapshot(), before)
        self.sql("DELETE w FROM Watchlists w JOIN Users u ON u.id=w.user_id "
                 "WHERE u.username='fixture_one'")
        assert_targets(WATCHED_PAIRS)
        self.sql("DELETE w FROM Watchlists w JOIN Sections s ON s.id=w.section_id WHERE s.subject='CS'")
        assert_targets([WATCHED_PAIRS[1]])
        self.sql("DELETE FROM Watchlists")
        assert_targets([])

    def test_scheduled_upserts_and_retries_preserve_identity(self):
        original, watches = self.seed_watchlists()
        self.scheduled_batch(INITIAL_COUNTS)
        stored = self.snapshot()
        self.assertEqual(len(stored["Courses"]), 3)
        self.assertEqual(len(stored["Sections"]), 4)
        self.assertEqual(len(stored["DepartmentSyncs"]), 2)
        self.assertEqual([(row["subject"], row["term"]) for row in stored["DepartmentSyncs"]],
                         [("CS", "202710"), ("IT", "202795")])
        self.assertTrue(all(row["last_synced_at"] for row in stored["DepartmentSyncs"]))
        self.assertTrue(all(row["course_id"] and row["status"] == "OPEN" and row["capacity"] == 30
                            and row["enrolled"] == 20 and row["last_checked_at"] for row in stored["Sections"]))
        self.assertEqual({(row["subject"], row["course_number"]): row["title"] for row in stored["Courses"]},
                         {("CS", "100"): "Introduction", ("IT", "101"): "Introduction",
                          ("IT", "490"): "Special Topics - AI"})
        self.assertEqual({row["crn"]: row["section_number"] for row in stored["Sections"]},
                         {"12345": "001", "12346": "H01", "54321": "001", "54322": "H01"})
        ids = {row["crn"]: row["id"] for row in stored["Sections"]}
        self.assertTrue(all(ids[row["crn"]] == row["id"] for row in original))
        self.assertEqual(stored["Watchlists"], watches)
        self.age_timestamps()
        aged = self.snapshot()
        self.scheduled_batch([(1, 2, 0), (2, 2, 0)])
        retried = self.snapshot()
        self.assertEqual(retried["Courses"], stored["Courses"])
        self.assertEqual(retried["Watchlists"], watches)
        for table, timestamp in (("Sections", "last_checked_at"), ("DepartmentSyncs", "last_synced_at")):
            self.assertEqual(len(retried[table]), len(aged[table]))
            for current, previous in zip(retried[table], aged[table]):
                self.assertNotEqual(current[timestamp], previous[timestamp])
                self.assertEqual(dict(current, **{timestamp: previous[timestamp]}), previous)
        self.scheduled_batch([(1, 2, 2), (2, 2, 2)], status="CLOSED")
        self.assertTrue(all(row["status"] == "CLOSED" for row in self.snapshot()["Sections"]))
        self.scheduled_batch([(1, 2, 0), (2, 2, 0)], status="CLOSED")

    def test_invalid_credentials_reject_get_and_post_without_writes(self):
        self.seed_watchlists()
        before = self.snapshot()
        for mode, options in (("targets", {}), ("targets", {"watched_only": True}),
                              ("submit", {"subject": "IT", "term": "202795"})):
            result = self.probe(mode, invalid_token=True, **options)
            self.assertIn("HTTP 401", result["error"])
        self.assertEqual(self.snapshot(), before)

    def test_ingestion_request_limits_through_actual_nginx(self):
        maximum = 5 * 1024 * 1024
        large = {"section_count": 1500, "comments_length": 800}
        ids = None
        for proxied in (False, True):
            with self.subTest(proxied=proxied, case="large valid observations"):
                result = self.probe("ingestion_http", proxied=proxied, **large)
                self.assertGreater(result["request_bytes"], 1024 * 1024)
                self.assertLess(result["request_bytes"], maximum)
                self.assertEqual(result["status"], 200, result)
                self.assertEqual(result["body"], {"courses": 1, "sections": 1500, "status_changes": 0})
                stored = self.sql("SELECT id,crn FROM Sections ORDER BY crn")
                self.assertEqual(len(stored), 1500)
                if ids is not None:
                    self.assertEqual(stored, ids, "proxy retries preserve existing identities")
                ids = stored
            with self.subTest(proxied=proxied, case="exact maximum"):
                result = self.probe("ingestion_http", proxied=proxied, body_bytes=maximum)
                self.assertEqual(result["request_bytes"], maximum)
                self.assertEqual(result["status"], 200, result)
                self.assertEqual(result["body"], {"courses": 1, "sections": 1, "status_changes": 0})
            before = self.snapshot()
            for options, status in (({"body_bytes": maximum + 1}, 413),
                                    ({**large, "missing_token": True}, 401),
                                    ({**large, "invalid_token": True}, 401),
                                    ({**large, "invalid_row": True}, 400)):
                with self.subTest(proxied=proxied, options=options):
                    result = self.probe("ingestion_http", proxied=proxied, **options)
                    self.assertEqual(result["status"], status, result)
                    self.assertEqual(self.snapshot(), before, "rejected requests cannot modify stored observations")
        # Express accepts the trailing slash/case aliases; the proxy limit must
        # cover them without granting a larger body to other public API routes.
        alias = self.probe("ingestion_http", proxied=True, path="/api/internal/sync/DEPARTMENT/", **large)
        self.assertEqual(alias["status"], 200, alias)
        before = self.snapshot()
        for size in (16 * 1024, maximum):
            result = self.probe("ingestion_http", proxied=True, path="/api/auth/login", body_bytes=size)
            self.assertEqual(result["status"], 413, result)
            if size > 1024 * 1024:
                self.assertIsNone(result["body"], "unrelated routes must retain Nginx's 1 MiB rejection")
            else:
                self.assertEqual(result["body"], {"error": "Request too large"}, "Express retains its 8 KiB auth limit")
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.probe("options", authenticated=False)["status"], 401)
        # Verify the envsubst-generated configuration in the actual production image.
        self.command("exec", "-T", "frontend", "nginx", "-t")

    def test_synchronized_course_search_through_proxy(self):
        self.seed_watchlists()
        # These legacy watches belong to observed fixture CRNs. Pagination must
        # not rely on deactivating unrelated, omitted sections to reach 53 rows.
        self.sql("UPDATE Sections SET crn = CASE crn WHEN '12345' THEN '12000' ELSE '12001' END WHERE subject = 'CS'")
        self.scheduled_batch([(1, 53, 2), (2, 2, 1)], section_count=53, mixed=True, title_variants=True,
                             vary_enrollment=True)
        before = self.snapshot()
        self.assertEqual(self.sql("SELECT title FROM Courses WHERE subject=? AND course_number=?", ["CS", "100"]),
                         [{"title": "Introduction"}], "lowest-CRN title survives the other 52 topic titles")
        observed = [row for row in before["Sections"] if row["subject"] == "CS" and row["term"] == "202710"
                    and row["is_active"] == 1]
        self.assertEqual(len(observed), 53)
        self.assertTrue(all(row["course_id"] is not None for row in observed))
        query = {"term": "202710", "subject": "CS"}
        self.assertEqual(self.probe("search", authenticated=False, queries=[query])[0]["status"], 401)
        rejected = self.probe("search", queries=[{"term": "202710"},
                                                {"term": "202710", "query": "CS 100"},
                                                {"term": "202710", "subject": ""}])
        self.assertTrue(all(row["status"] == 400 for row in rejected), rejected)
        queries = [query, {**query, "query": "100"}, {**query, "query": " cs  100 "},
                   *[{**query, "status": status} for status in ("OPEN", "CLOSED", "CANCELLED")],
                   {**query, "sort": "crn", "order": "desc", "limit": 2, "offset": 1},
                   {**query, "sort": "availability", "order": "asc", "limit": 2},
                   {"term": "202795", "subject": "IT"},
                   {"term": "202710", "subject": "ECE"}, {"term": "202790", "subject": "CS"},
                   {**query, "offset": 50}, {**query, "offset": 53},
                   *[{**query, "sort": sort, "order": order, "limit": 100}
                     for sort in ("course", "crn", "availability") for order in ("asc", "desc")]]
        responses = self.probe("search", queries=queries)
        self.assertTrue(all(row["status"] == 200 for row in responses), responses)
        bodies = [row["body"] for row in responses]
        for body in bodies[:3]:
            self.assertEqual(body["pagination"], {"limit": 50, "offset": 0, "total": 53})
            self.assertEqual(len(body["sections"]), 50)
            self.assertTrue(all(row["subject"] == "CS" and row["course"] == "CS 100"
                                and row["title"] == "Introduction" and row["is_active"] is True
                                for row in body["sections"]))
        for body, status, total in zip(bodies[3:6], ("OPEN", "CLOSED", "CANCELLED"), (18, 18, 17)):
            self.assertEqual(body["pagination"]["total"], total)
            self.assertTrue(all(row["status"] == status for row in body["sections"]))
        self.assertEqual([row["crn"] for row in bodies[6]["sections"]], ["12051", "12050"])
        self.assertEqual(bodies[6]["pagination"], {"limit": 2, "offset": 1, "total": 53})
        self.assertEqual([row["crn"] for row in bodies[7]["sections"]], ["12002", "12005"])
        self.assertEqual(bodies[8]["pagination"]["total"], 2)
        for body in bodies[9:11]:
            self.assertEqual(body, {"sections": [], "pagination": {"limit": 50, "offset": 0, "total": 0}})
        self.assertEqual(bodies[11]["pagination"], {"limit": 50, "offset": 50, "total": 53})
        self.assertEqual([row["crn"] for row in bodies[11]["sections"]], ["12050", "12051", "12052"])
        self.assertEqual(bodies[12], {"sections": [], "pagination": {"limit": 50, "offset": 53, "total": 53}})
        for index, body in enumerate(bodies[13:]):
            expected = [str(crn) for crn in range(12000, 12053)]
            if index // 2 == 2:  # availability: capacity 30, enrollment 20/21/22
                expected = [str(12000 + i) for i in sorted(range(53), key=lambda i: (10 - i % 3, i))]
            if index % 2:
                expected.reverse()
            self.assertEqual(body["pagination"], {"limit": 100, "offset": 0, "total": 53})
            self.assertEqual([row["crn"] for row in body["sections"]], expected)
        # Search cannot fetch public Banner: both API networks are internal.
        # Full-row snapshots detect writes, including synchronization timestamps.
        self.assertEqual(self.snapshot(), before)
        if os.environ.get("RUN_BROWSER_TESTS") == "1":
            # Nullable legacy values cannot arrive through the normalized sync API.
            self.sql("UPDATE Sections SET capacity=NULL,enrolled=NULL WHERE term=? AND crn=?", ["202710", "12000"])
            browser_before = self.snapshot()
            self.verify_browser()
            self.assertEqual(self.snapshot(), browser_before)
            # The browser deliberately expires every test session. Renew the
            # probe's real cookie through login, reusing its existing account.
            self.session_cookies = self.probe("authenticate", register=False)["cookies"]
        self.scheduled_batch([(1, 53, 35), (2, 2, 1)], section_count=53, status="CLOSED", enrolled=29,
                             title_variants=True)
        after = self.probe("search", queries=[query])[0]["body"]
        self.assertTrue(all(row["status"] == "CLOSED" and row["now"] == 29 for row in after["sections"]))
        self.assertEqual(after["pagination"]["total"], 53)
        self.assertEqual(self.sql("SELECT id,crn FROM Sections ORDER BY id"),
                         [{"id": row["id"], "crn": row["crn"]} for row in before["Sections"]])
        self.scheduled_batch([(1, 53, 0), (2, 2, 0)], section_count=53, status="CLOSED", enrolled=29,
                             title_variants=True)
        self.assertEqual(len(self.snapshot()["Sections"]), len(before["Sections"]))

    def test_local_catalog_options_follow_searchable_pairs_without_writes(self):
        self.assertEqual(self.probe("options", authenticated=False)["status"], 401)
        self.assertEqual(self.probe("options"), {"status": 200, "body": {"terms": []}})
        if os.environ.get("RUN_BROWSER_TESTS") == "1":
            self.verify_browser(empty=True)
        # Catalog entries and unlinked sections alone must not advertise availability.
        self.sql("INSERT INTO Courses(subject,course_number,title) VALUES ('PHIL','100','Unscheduled')")
        self.sql("INSERT INTO Sections(subject,term,crn) VALUES ('MATH','202790','99999')")
        self.assertEqual(self.probe("submit", subject="ECE", term="202695")["sections"], 2)
        self.assertEqual(self.probe("submit", subject="CS", term="202710")["sections"], 2)
        self.assertEqual(self.probe("submit", subject="IT", term="202710")["sections"], 2)
        before = self.snapshot()
        self.assertEqual(self.probe("options"), {"status": 200, "body": {"terms": [
            {"code": "202710", "departments": ["CS", "IT"]},
            {"code": "202695", "departments": ["ECE"]},
        ]}})
        self.assertEqual(self.snapshot(), before)
        queries = [{"term": "202710", "subject": "CS"}, {"term": "202710", "subject": "IT"},
                   {"term": "202695", "subject": "ECE"}, {"term": "202710", "subject": "ECE"}]
        filtered = self.probe("search", queries=queries)
        for response, filters, expected in zip(filtered, queries, (2, 2, 2, 0)):
            self.assertEqual(response["status"], 200)
            self.assertEqual(response["body"]["pagination"]["total"], expected)
            self.assertTrue(all(row["term"] == filters["term"] and row["subject"] == filters["subject"]
                                for row in response["body"]["sections"]))
        self.assertEqual(self.snapshot(), before)

    def test_banner_failure_preserves_all_records_and_sync_times(self):
        self.seed_watchlists()
        self.scheduled_batch(INITIAL_COUNTS)
        self.age_timestamps()
        before = self.snapshot()
        result = self.scheduled_batch(banner_failure=True)
        self.assertEqual(result["submit_attempts"], [])
        self.assertEqual(result["submissions"], [])
        self.assertEqual(result["errors"], [
            f"watched synchronization failed for {subject} {term}: Fixture Banner service unavailable"
            for subject, term in WATCHED_PAIRS
        ])
        self.assertEqual(self.snapshot(), before)

    def test_scheduler_regular_syncs_two_terms_without_watches(self):
        priority = self.probe("scheduled", departments=["IT"], terms=["202710", "202795"], kind="watched")
        self.assertEqual(priority["banner_calls"], [])
        self.assertEqual(priority["submit_attempts"], [])
        self.assertEqual(priority["errors"], [])
        self.assertEqual(self.snapshot()["DepartmentSyncs"], [])
        regular = self.probe("scheduled", departments=["IT", "CS"], terms=["202710", "202795"])
        self.assertEqual(regular["banner_calls"], [["IT", "202710"], ["IT", "202795"]])
        self.assertEqual(regular["submit_attempts"], regular["banner_calls"])
        self.assertEqual(regular["errors"], [])
        self.assertEqual(regular["next_subject"], "CS")
        self.assertEqual(self.sql("SELECT subject,term FROM DepartmentSyncs ORDER BY term"),
                         [{"subject": "IT", "term": "202710"}, {"subject": "IT", "term": "202795"}])

    def test_scheduler_excludes_watched_pair_from_regular_and_syncs_it_in_priority_slot(self):
        self.seed_watchlists()
        regular = self.probe("scheduled", departments=["CS", "IT"], terms=["202710", "202795"])
        self.assertEqual(regular["banner_calls"], [["CS", "202795"]])
        self.assertEqual(regular["submit_attempts"], regular["banner_calls"])
        self.assertEqual(regular["errors"], [])
        priority = self.probe("scheduled", departments=["CS", "IT"], terms=["202710", "202795"], kind="watched")
        self.assertEqual(priority["banner_calls"], WATCHED_PAIRS)
        self.assertEqual(priority["submit_attempts"], WATCHED_PAIRS)
        self.assertEqual(priority["errors"], [])
        self.assertEqual(self.sql("SELECT subject,term FROM DepartmentSyncs ORDER BY subject,term"), [
            {"subject": "CS", "term": "202710"}, {"subject": "CS", "term": "202795"},
            {"subject": "IT", "term": "202795"}])
        self.assertEqual(len(self.snapshot()["Watchlists"]), 4)

    def test_empty_sync_retains_rows_ids_watchlists_and_section_timestamps(self):
        self.seed_watchlists()
        self.scheduled_batch(INITIAL_COUNTS)
        # Exercise preservation of both activity states, not only default-active rows.
        self.sql("UPDATE Sections SET is_active=FALSE WHERE subject=? AND term=? AND crn=?",
                 ["CS", "202710", "12346"])
        self.age_timestamps()
        before = self.snapshot()
        self.scheduled_batch([(0, 0, 0), (0, 0, 0)], banner_fixture="empty")
        after = self.snapshot()
        for table in ("Courses", "Sections", "Watchlists"):
            self.assertEqual(after[table], before[table], table)
        self.assertTrue(all(row["last_synced_at"] != "2000-01-01 00:00:00" for row in after["DepartmentSyncs"]))
        self.assertEqual(self.probe("submit", subject="DS", term="202710", banner_fixture="empty"),
                         {"courses": 0, "sections": 0, "status_changes": 0})
        self.assertEqual(self.snapshot()["Sections"], before["Sections"])

    def test_section_preservation_through_python_api_search_and_watchlist(self):
        # CS fixtures use stable CRNs 12000/12001 for section_count=2. Mixed
        # status makes the returning section CLOSED while the survivor stays OPEN.
        self.assertEqual(self.probe("submit", subject="CS", term="202710", section_count=2, mixed=True, title_variants=True),
                         {"courses": 1, "sections": 2, "status_changes": 0})
        query = {"term": "202710", "subject": "CS"}

        def search():
            response = self.probe("search", queries=[query])[0]
            self.assertEqual(response["status"], 200)
            return response["body"]

        original = search()  # Creates the authenticated fixture user as usual.
        ids = {row["crn"]: row["id"] for row in original["sections"]}
        self.assertEqual(set(ids), {"12000", "12001"})
        self.assertTrue(all(row["is_active"] is True for row in original["sections"]))
        self.sql("INSERT INTO Watchlists(user_id,section_id) "
                 "SELECT id,? FROM Users WHERE username=?", [ids["12001"], "course_search_fixture"])
        before = self.snapshot()
        missing = next(row for row in before["Sections"] if row["id"] == ids["12001"])
        self.assertEqual(missing["status"], "CLOSED")

        self.assertEqual(self.probe("submit", subject="CS", term="202710", section_count=1),
                         {"courses": 1, "sections": 1, "status_changes": 0})
        after = self.snapshot()
        self.assertEqual(next(row for row in after["Sections"] if row["id"] == ids["12001"]),
                         missing, "omission preserves every section field")
        self.assertEqual(after["Watchlists"], before["Watchlists"])
        visible = search()
        self.assertEqual(visible["pagination"]["total"], 2)
        self.assertEqual({row["id"] for row in visible["sections"]}, set(ids.values()))
        watched = self.probe("watchlist")
        self.assertEqual(watched["status"], 200)
        self.assertEqual(len(watched["body"]["sections"]), 1)
        retained = watched["body"]["sections"][0]
        self.assertEqual(retained["section_id"], ids["12001"])
        self.assertIs(retained["is_active"], True)
        self.assertEqual(retained["status"], "CLOSED")
        self.assertEqual(retained["last_checked_at"], missing["last_checked_at"])
        self.assertIn({"subject": "CS", "term": "202710"}, self.probe("targets")["targets"],
                      "an omitted watched section must remain monitored")

        self.assertEqual(self.probe("submit", subject="CS", term="202710", section_count=2, title_variants=True),
                         {"courses": 1, "sections": 2, "status_changes": 1},
                         "a preserved active section still compares its explicit observations")
        restored = search()
        self.assertEqual({row["crn"]: row["id"] for row in restored["sections"]}, ids)
        self.assertTrue(all(row["is_active"] is True for row in restored["sections"]))
        returned_watch = self.probe("watchlist")["body"]["sections"][0]
        self.assertEqual(returned_watch["section_id"], ids["12001"])
        self.assertIs(returned_watch["is_active"], True)
        self.assertEqual(returned_watch["status"], "OPEN")
        self.assertEqual(self.snapshot()["Watchlists"], before["Watchlists"])
        for status in ("CLOSED", "OPEN"):
            self.assertEqual(self.probe("submit", subject="CS", term="202710", section_count=2, status=status),
                             {"courses": 1, "sections": 2, "status_changes": 2},
                             "continuously active status transitions still count")

    def test_valid_partial_responses_preserve_omitted_rows_courses_and_items(self):
        for fixture, omitted_crn, omitted_active in (
            ("preservation_missing_row", "01235", 1),
            ("preservation_missing_row", "01235", 0),
            ("preservation_missing_course", "02234", 1),
            ("preservation_missing_course", "02234", 0),
            ("preservation_missing_item", "02234", 1),
            ("preservation_missing_item", "02234", 0),
        ):
            with self.subTest(fixture=fixture, omitted_active=omitted_active):
                self.setUp()  # Only this test-owned stack; isolate each response shape.
                full = "preservation_full_items" if fixture.endswith("item") else "preservation_full"
                self.assertEqual(self.probe("submit", subject="DS", term="202710", banner_fixture=full),
                                 {"courses": 2, "sections": 3, "status_changes": 0})
                self.sql("INSERT INTO Users(username,email,password_hash) VALUES(?,?,?)",
                         ["preservation_watcher", "preservation@example.invalid", "unused"])
                self.sql("INSERT INTO Watchlists(user_id,section_id) SELECT u.id,s.id FROM Users u CROSS JOIN Sections s")
                # Exercise omission of both historical inactive and active sections.
                self.sql("UPDATE Sections SET is_active=FALSE WHERE crn=?", ["01235"])
                self.sql("UPDATE Sections SET is_active=? WHERE crn=?", [omitted_active, omitted_crn])
                self.age_timestamps()
                before = self.snapshot()
                result = self.probe("submit", subject="DS", term="202710", banner_fixture=fixture)
                self.assertEqual(result["sections"], 2)
                self.assertEqual(result["status_changes"], 1)
                after = self.snapshot()
                by_crn = lambda rows: {row["crn"]: row for row in rows}
                old, new = by_crn(before["Sections"]), by_crn(after["Sections"])
                self.assertEqual(new[omitted_crn], old[omitted_crn], "all omitted fields must remain byte-for-byte equivalent")
                self.assertEqual(after["Watchlists"], before["Watchlists"])
                self.assertEqual({crn: row["id"] for crn, row in new.items()},
                                 {crn: row["id"] for crn, row in old.items()})
                self.assertEqual((new["01234"]["status"], new["01234"]["enrolled"], new["01234"]["is_active"]),
                                 ("CLOSED", 30, 1))
                self.assertNotEqual(new["01234"]["last_checked_at"], old["01234"]["last_checked_at"])
                self.assertNotEqual(after["DepartmentSyncs"][0]["last_synced_at"], before["DepartmentSyncs"][0]["last_synced_at"])
                if omitted_crn != "01235":
                    self.assertEqual(new["01235"]["is_active"], 1, "explicitly observed inactive sections reactivate")
                repeated = self.probe("submit", subject="DS", term="202710", banner_fixture=fixture)
                self.assertEqual(repeated["status_changes"], 0)
                retried = self.snapshot()
                self.assertEqual(by_crn(retried["Sections"])[omitted_crn], old[omitted_crn])
                self.assertEqual(retried["Watchlists"], before["Watchlists"])

    def test_section_activity_schema_and_existing_mariadb_migration_regressions(self):
        columns = self.sql("SHOW COLUMNS FROM Sections LIKE 'is_active'")
        self.assertEqual(len(columns), 1, "disposable initialization must include is_active")
        self.assertTrue(columns[0]["Type"].lower().startswith("tinyint"))
        self.assertEqual(columns[0]["Null"], "NO")
        self.assertEqual(str(columns[0]["Default"]), "1")
        for table in ("Sections", "DepartmentSyncs"):
            self.assertEqual(self.sql(f"SHOW COLUMNS FROM {table} LIKE 'snapshot_generation'"), [])
        # Reuse rather than copy the existing migration/experimental-column/SQL
        # regressions. They create/drop only their own random schema on this test DB.
        output = self.command("exec", "-T", "-e", "TEST_DB_HOST=db", "-e", "TEST_DB_PORT=3306",
                              "-e", "TEST_DB_PASSWORD=integration-only-password", "backend",
                              "node", "--test", "test/section-activity.test.cjs")
        print(output, flush=True)

    def test_session_cookie_restoration_and_expiration_regressions(self):
        output = self.command("exec", "-T", "-e", "TEST_DB_HOST=db", "-e", "TEST_DB_PORT=3306",
                              "-e", "TEST_DB_PASSWORD=integration-only-password", "backend",
                              "node", "--test", "test/auth.test.cjs")
        print(output, flush=True)

    def test_malformed_fixture_never_advances_completion(self):
        self.seed_watchlists()
        self.scheduled_batch(INITIAL_COUNTS)
        self.age_timestamps()
        before = self.snapshot()
        for fixture, field, reason, index in (
            ("missing_table", "SECTIONS_TABLE", "missing_course_table", None),
            ("partial", "SECTIONS_TABLE", "missing_course_table", None),
            ("truncated", "SECTIONS_TABLE", "incomplete_markup", None),
            ("invalid_envelope", "response", "invalid_envelope", None),
            ("invalid_status", "status", "invalid_status", 0),
            ("unexpected_empty_markup", "SECTIONS_TABLE", "missing_course_table", None),
        ):
            with self.subTest(fixture=fixture):
                result = self.scheduled_batch(banner_fixture=fixture)
                self.assertEqual(result["submit_attempts"], [])
                self.assertEqual(result["submissions"], [])
                diagnostic = json.dumps({"event": "banner_validation_failed", "field": field, "row_index": index,
                                         "reason": reason})
                self.assertEqual(result["errors"], [
                    f"watched synchronization failed for {subject} {term}: {diagnostic}"
                    for subject, term in WATCHED_PAIRS
                ])
                self.assertEqual(self.snapshot(), before)

    def test_synthetic_ds_section_title_variants_and_duplicate_crn_diagnostics(self):
        counts = self.probe("submit", subject="DS", term="202710", banner_fixture="valid")
        self.assertEqual(counts, {"courses": 1, "sections": 1, "status_changes": 0})
        self.assertEqual(self.sql("SELECT crn,enrolled,capacity FROM Sections"),
                         [{"crn": "01234", "enrolled": 31, "capacity": 30}])
        original_id = self.sql("SELECT id FROM Sections")[0]["id"]
        variants = self.probe("submit", subject="DS", term="202710", banner_fixture="conflicting_titles")
        self.assertEqual(variants, {"courses": 1, "sections": 2, "status_changes": 0})
        self.assertEqual(self.sql("SELECT title FROM Courses"), [{"title": "Introduction to Big Data"}])
        self.assertEqual(self.sql("SELECT id FROM Sections WHERE crn='01234'"), [{"id": original_id}])
        self.assertEqual(self.sql("SELECT crn,is_active FROM Sections ORDER BY crn"),
                         [{"crn": "01234", "is_active": 1}, {"crn": "01235", "is_active": 1}])
        self.age_timestamps()
        before = self.snapshot()
        rejected = self.probe("submit", subject="DS", term="202710", banner_fixture="conflicting_duplicate_crn_titles")
        self.assertIn("HTTP 400", rejected["error"])
        self.assertIn('"field": "crn", "row_index": 1, "reason": "conflicting_crn"', rejected["error"])
        self.assertEqual(self.snapshot(), before)

    def test_backend_failure_rolls_back_existing_and_new_records(self):
        self.seed_watchlists()
        self.scheduled_batch(INITIAL_COUNTS)
        self.age_timestamps()
        before = self.snapshot()
        self.sql("CREATE TRIGGER integration_fail_sync BEFORE INSERT ON DepartmentSyncs "
                 "FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture failure'")
        try:
            # A new CS CRN omits the two stored ones. Failure at department
            # completion must roll back observed upserts while omitted rows stay intact.
            result = self.scheduled_batch(status="CLOSED", section_count=1)
            self.assertEqual(result["submit_attempts"], WATCHED_PAIRS)
            self.assertEqual(result["submissions"], [])
            self.assertEqual(result["errors"], [
                f"watched synchronization failed for {subject} {term}: Department synchronization failed (HTTP 503)."
                for subject, term in WATCHED_PAIRS
            ])
            self.assertEqual(self.snapshot(), before)
            failed_insert = self.probe("submit", subject="ECE", term="202790")
            self.assertIn("HTTP 503", failed_insert["error"])
            self.assertEqual(self.snapshot(), before)
        finally:
            self.sql("DROP TRIGGER integration_fail_sync")
        self.scheduled_batch([(1, 1, 0), (2, 2, 2)], status="CLOSED", section_count=1)
        cs = self.sql("SELECT crn,is_active FROM Sections WHERE subject=? AND term=? ORDER BY crn",
                      ["CS", "202710"])
        self.assertEqual(cs, [{"crn": "12000", "is_active": 1}, {"crn": "12345", "is_active": 1},
                              {"crn": "12346", "is_active": 1}])

    def test_checker_has_no_database_credentials_imports_or_network_access(self):
        container = self.command("ps", "-q", "db").strip()
        inspected = subprocess.run(["docker", "inspect", container], check=True,
                                   stdout=subprocess.PIPE, text=True, timeout=30)
        network = next(iter(json.loads(inspected.stdout)[0]["NetworkSettings"]["Networks"].values()))
        self.assertEqual(self.probe("network", database_ip=network["IPAddress"]), {"database_access": False})

    def test_application_compose_environment(self):
        env = dict(os.environ, DB_PASSWORD="fixture-only-db", DB_ROOT_PASSWORD="fixture-only-root",
                   SESSION_SECRET="fixture-only-session-secret-0123456789", CHECKER_API_TOKEN="fixture-only-token",
                   CHECKER_API_URL="http://backend:3000", CHECKER_TERMS='["202710"]')
        result = subprocess.run(["docker", "compose", "--env-file", os.devnull, "-f", str(ROOT / "compose.yaml"),
                                 "config", "--format", "json"], env=env, check=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
        services = json.loads(result.stdout)["services"]
        checker = services["checker"]
        backend_env = services["backend"]["environment"]
        self.assertFalse(any(key.startswith("DB_") for key in checker["environment"]))
        self.assertEqual(checker["environment"]["CHECKER_API_URL"], "http://backend:3000")
        self.assertEqual(checker["environment"]["CHECKER_API_TOKEN"], backend_env["CHECKER_API_TOKEN"])
        self.assertEqual(json.loads(checker["environment"]["CHECKER_TERMS"]), ["202710"])
        self.assertEqual(backend_env["SEARCH_TERMS"], checker["environment"]["CHECKER_TERMS"])
        self.assertEqual(checker["depends_on"]["backend"]["condition"], "service_healthy")
        self.assertNotIn("db", checker["depends_on"])
        integration = json.loads(self.command("config", "--format", "json"))["services"]
        for service in (*services.values(), *integration.values()):
            self.assertNotIn("CHECKER_MONITORING_TARGETS", service.get("environment", {}))
            self.assertNotIn("DISCORD_WEBHOOK_URL", service.get("environment", {}))
        # Run the existing HTTPS/cookie smoke test against this test-owned DB.
        # Its production environment changes apply only to the child process.
        output = self.command("exec", "-T", "backend", "node",
                              input=(ROOT / "backend/test/production.cjs").read_text())
        self.assertIn("PASS:", output)


if __name__ == "__main__":
    unittest.main(verbosity=2)
