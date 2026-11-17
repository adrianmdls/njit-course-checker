"""Run explicitly: python3 -B tests/integration/test_pipeline.py (Docker required).

Only the randomly named disposable stack created here is inspected or changed.
Host Python uses the standard library; checker SQL inspection runs in the backend.
"""

import json
import os
from pathlib import Path
import subprocess
import unittest
import uuid


ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "tests" / "integration" / "compose.yaml"
SQL = """const pool = require('./src/db');
pool.execute(process.argv[1], JSON.parse(process.argv[2]))
  .then(([rows]) => process.stdout.write(JSON.stringify(rows)))
  .catch(error => { console.error(error.code || 'SQL failed'); process.exitCode = 1; })
  .finally(() => pool.end());"""


class PipelineTests(unittest.TestCase):
    @classmethod
    def command(cls, *args, input=None):
        result = subprocess.run(cls.compose + list(args), input=input, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=600)
        if result.returncode:
            raise AssertionError(f"Docker command failed: {args[0]}\n{result.stdout}\n{result.stderr}")
        return result.stdout

    @classmethod
    def setUpClass(cls):
        cls.compose = ["docker", "compose", "--env-file", os.devnull,
                       "-p", f"njit-banner-test-{uuid.uuid4().hex[:10]}", "-f", str(COMPOSE)]
        cls.addClassCleanup(cls.cleanup)
        print("Building disposable integration stack...", flush=True)
        cls.command("build", "backend", "checker-test")
        cls.command("up", "-d", "--wait", "--wait-timeout", "120", "backend", "db")

    @classmethod
    def cleanup(cls):
        cls.command("down", "--volumes", "--remove-orphans")

    @classmethod
    def sql(cls, statement, params=None):
        return json.loads(cls.command("exec", "-T", "backend", "node", "-e", SQL,
                                      statement, json.dumps(params or [])))

    def probe(self, mode, **options):
        return json.loads(self.command("run", "--rm", "--no-deps", "-T", "checker-test",
                                       input=json.dumps({"mode": mode, **options})))

    def setUp(self):
        for table in ("Watchlists", "Sections", "Courses", "Users", "DepartmentSyncs"):
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

    def snapshot(self):
        return {table: self.sql(f"SELECT * FROM {table} ORDER BY " +
                               ("subject,term" if table == "DepartmentSyncs" else "id"))
                for table in ("Courses", "Sections", "Watchlists", "DepartmentSyncs")}

    def age_timestamps(self):
        # A mistaken refresh must remain visible even when requests run in the same second.
        self.sql("UPDATE Sections SET last_checked_at = ?", ["2000-01-01 00:00:00"])
        self.sql("UPDATE DepartmentSyncs SET last_synced_at = ?", ["2000-01-01 00:00:00"])

    def test_configured_and_watched_targets_merge(self):
        self.assertEqual(self.probe("targets"), {"targets": [{"subject": "IT", "term": "202795"}]})
        self.seed_watchlists()
        self.assertEqual(self.probe("targets"), {"targets": [
            {"subject": "CS", "term": "202710"}, {"subject": "IT", "term": "202795"}]})

    def test_polling_upserts_and_retries_preserve_identity(self):
        original, watches = self.seed_watchlists()
        result = self.probe("poll")
        self.assertEqual(result["errors"], 0, result)
        self.assertEqual(result["banner_calls"], [["CS", "202710"], ["IT", "202795"]])
        self.assertTrue(all("1 status changes" in row for row in result["results"]), result)
        stored = self.snapshot()
        self.assertEqual(len(stored["Courses"]), 3)
        self.assertEqual(len(stored["Sections"]), 4)
        self.assertEqual(len(stored["DepartmentSyncs"]), 2)
        self.assertEqual([(row["subject"], row["term"]) for row in stored["DepartmentSyncs"]],
                         [("CS", "202710"), ("IT", "202795")])
        self.assertTrue(all(row["last_synced_at"] for row in stored["DepartmentSyncs"]))
        self.assertTrue(all(row["course_id"] and row["status"] == "OPEN" and row["capacity"] == 30
                            and row["enrolled"] == 20 for row in stored["Sections"]))
        self.assertEqual({(row["subject"], row["course_number"]): row["title"] for row in stored["Courses"]},
                         {("CS", "100"): "Introduction", ("IT", "101"): "Introduction",
                          ("IT", "490"): "Special Topics - AI"})
        self.assertEqual({row["crn"]: row["section_number"] for row in stored["Sections"]},
                         {"12345": "001", "12346": "H01", "54321": "001", "54322": "H01"})
        ids = {row["crn"]: row["id"] for row in stored["Sections"]}
        self.assertTrue(all(ids[row["crn"]] == row["id"] for row in original))
        self.assertEqual(stored["Watchlists"], watches)
        repeated = self.probe("poll")
        self.assertEqual(repeated["errors"], 0)
        self.assertTrue(all("0 status changes" in row for row in repeated["results"]), repeated)
        self.assertEqual(self.sql("SELECT id,crn FROM Sections ORDER BY id"),
                         [{"id": row["id"], "crn": row["crn"]} for row in stored["Sections"]])
        self.assertEqual(self.sql("SELECT COUNT(*) AS count FROM Courses")[0]["count"], 3)
        self.assertEqual(self.sql("SELECT * FROM Watchlists ORDER BY id"), watches)
        changed = self.probe("submit", subject="CS", term="202710", status="CLOSED")
        self.assertEqual(changed, {"courses": 1, "sections": 2, "status_changes": 2})
        self.assertEqual(self.probe("submit", subject="CS", term="202710", status="CLOSED"),
                         {"courses": 1, "sections": 2, "status_changes": 0})

    def test_invalid_credentials_reject_get_and_post_without_writes(self):
        self.seed_watchlists()
        before = self.snapshot()
        for mode in ("targets", "submit"):
            result = self.probe(mode, invalid_token=True, subject="IT", term="202795")
            self.assertIn("HTTP 401", result["error"])
        self.assertEqual(self.snapshot(), before)

    def test_banner_failure_preserves_all_records_and_sync_times(self):
        self.seed_watchlists()
        self.assertEqual(self.probe("poll")["errors"], 0)
        self.age_timestamps()
        before = self.snapshot()
        result = self.probe("poll", banner_failure=True)
        self.assertEqual(result["errors"], 2, result)
        self.assertEqual(self.snapshot(), before)

    def test_backend_failure_rolls_back_existing_and_new_records(self):
        self.seed_watchlists()
        self.assertEqual(self.probe("poll")["errors"], 0)
        self.age_timestamps()
        before = self.snapshot()
        self.sql("CREATE TRIGGER integration_fail_sync BEFORE INSERT ON DepartmentSyncs "
                 "FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture failure'")
        try:
            result = self.probe("poll", status="CLOSED")
            self.assertEqual(result["errors"], 2, result)
            self.assertTrue(all("HTTP 503" in row for row in result["results"]), result)
            self.assertEqual(self.snapshot(), before)
            failed_insert = self.probe("submit", subject="ECE", term="202790")
            self.assertIn("HTTP 503", failed_insert["error"])
            self.assertEqual(self.snapshot(), before)
        finally:
            self.sql("DROP TRIGGER integration_fail_sync")
        self.assertEqual(self.probe("poll", status="CLOSED")["errors"], 0)

    def test_actual_manual_checker_is_read_only(self):
        self.seed_watchlists()
        self.assertEqual(self.probe("poll")["errors"], 0)
        self.age_timestamps()
        before = self.snapshot()
        result = self.probe("manual", status="CLOSED")
        self.assertEqual(result["exit_code"], 0, result)
        self.assertIn("read-only", result["output"])
        self.assertEqual(self.snapshot(), before)

    def test_checker_has_no_database_credentials_imports_or_network_access(self):
        container = self.command("ps", "-q", "db").strip()
        inspected = subprocess.run(["docker", "inspect", container], check=True,
                                   stdout=subprocess.PIPE, text=True, timeout=30)
        network = next(iter(json.loads(inspected.stdout)[0]["NetworkSettings"]["Networks"].values()))
        self.assertEqual(self.probe("network", database_ip=network["IPAddress"]), {"database_access": False})

    def test_application_compose_environment(self):
        env = dict(os.environ, DB_PASSWORD="fixture-only-db", DB_ROOT_PASSWORD="fixture-only-root",
                   SESSION_SECRET="fixture-only-session-secret-0123456789", CHECKER_API_TOKEN="fixture-only-token",
                   CHECKER_API_URL="http://backend:3000", CHECKER_MONITORING_TARGETS='[{"subject":"IT","term":"202795"}]')
        result = subprocess.run(["docker", "compose", "--env-file", os.devnull, "-f", str(ROOT / "compose.yaml"),
                                 "config", "--format", "json"], env=env, check=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
        services = json.loads(result.stdout)["services"]
        checker = services["checker"]
        self.assertFalse(any(key.startswith("DB_") for key in checker["environment"]))
        self.assertEqual(checker["environment"]["CHECKER_API_URL"], "http://backend:3000")
        self.assertEqual(checker["environment"]["CHECKER_API_TOKEN"], services["backend"]["environment"]["CHECKER_API_TOKEN"])
        self.assertEqual(checker["depends_on"]["backend"]["condition"], "service_healthy")
        self.assertNotIn("db", checker["depends_on"])
        self.assertEqual(json.loads(services["backend"]["environment"]["CHECKER_MONITORING_TARGETS"]),
                         [{"subject": "IT", "term": "202795"}])


if __name__ == "__main__":
    unittest.main(verbosity=2)
