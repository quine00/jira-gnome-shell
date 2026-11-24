import contextlib
import io
import json
import os
import sys
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "extension", "helper"))
sys.path.insert(0, HERE)

import jirasprint  # noqa: E402
import mockjira  # noqa: E402

TEAM = "8b7e057e-d4d3-4dfc-a741-8a7c4521cf82"


class HelperTest(unittest.TestCase):
    def setUp(self):
        self.server, self.state = mockjira.serve()
        self.addCleanup(self.server.shutdown)
        self.env = {
            "JIRA_SPRINT_SERVER": f"http://127.0.0.1:{self.server.server_address[1]}/",
            "JIRA_SPRINT_LOGIN": "me@example.com",
            "JIRA_SPRINT_TOKEN": "secret",
        }
        self._old = {k: os.environ.get(k) for k in self.env}
        os.environ.update(self.env)
        self.addCleanup(self._restore)

    def _restore(self):
        for k, v in self._old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def run_helper(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = jirasprint.main(list(argv))
        return code, (json.loads(out.getvalue()) if out.getvalue() else None), err.getvalue().strip()

    def test_mine_groups_by_board_order_and_counts(self):
        code, data, _ = self.run_helper("snapshot", "--view", "mine")
        self.assertEqual(code, 0)
        self.assertEqual([g["status"] for g in data["groups"]],
                         ["In Progress", "In Review", "Triaged", "Done"])
        self.assertEqual((data["open"], data["done"]), (3, 1))
        self.assertEqual((data["points_open"], data["points_done"]), (8, 2))
        self.assertEqual(data["sprint"]["name"], "Pulse 2026#22")
        self.assertGreater(data["sprint"]["days_left"], 1000)
        self.assertEqual(data["server"], self.env["JIRA_SPRINT_SERVER"].rstrip("/"))
        first = data["groups"][0]["issues"][0]
        self.assertEqual((first["key"], first["points"], first["type"]), ("T-1", 3, "Task"))

    def test_basic_auth_is_login_and_token(self):
        self.run_helper("snapshot")
        import base64
        self.assertEqual(self.state.auth[-1],
                         "Basic " + base64.b64encode(b"me@example.com:secret").decode())

    def test_team_and_backlog_need_a_team(self):
        code, data, err = self.run_helper("snapshot", "--view", "team")
        self.assertEqual((code, data), (1, None))
        self.assertIn("team-id", err)
        code, data, _ = self.run_helper("snapshot", "--view", "team", "--team", TEAM)
        self.assertEqual(sum(len(g["issues"]) for g in data["groups"]), 5)
        code, data, _ = self.run_helper("snapshot", "--view", "backlog", "--team", TEAM)
        self.assertEqual([i["key"] for g in data["groups"] for i in g["issues"]], ["T-6"])
        self.assertIsNone(data["sprint"])

    def test_team_id_cannot_inject_jql(self):
        code, _, err = self.run_helper("snapshot", "--view", "team", "--team", 'x" OR project = SECRET')
        self.assertEqual(code, 1)
        self.assertIn("not a Jira Team id", err)

    def test_issue_detail(self):
        code, data, _ = self.run_helper("issue", "T-2")
        self.assertEqual(code, 0)
        self.assertEqual(data["description"], "Description of T-2.")
        self.assertEqual(data["comments"], [
            {"author": "Nathan", "created": "2026-11-17", "body": "A comment on T-2."}])
        self.assertIn({"id": "21", "name": "In Progress"}, data["transitions"])

    def test_move_changes_status(self):
        code, data, _ = self.run_helper("move", "T-2", "21")
        self.assertEqual((code, data), (0, {"key": "T-2", "moved": True}))
        self.assertEqual(self.state.moves, [["T-2", "21"]])
        _, snap, _ = self.run_helper("snapshot")
        self.assertEqual([i["key"] for i in snap["groups"][0]["issues"]], ["T-1", "T-2"])

    def test_bad_key_is_refused_before_any_request(self):
        code, _, err = self.run_helper("issue", "../../admin")
        self.assertEqual((code, err), (1, "not an issue key"))
        self.assertEqual(self.state.auth, [])

    def test_errors_are_one_legible_line(self):
        code, _, err = self.run_helper("issue", "T-99")
        self.assertEqual((code, err), (1, "Jira answered 404: Issue does not exist"))
        os.environ["JIRA_SPRINT_TOKEN"] = "bad"
        code, _, err = self.run_helper("snapshot")
        self.assertEqual((code, err), (1, "Jira rejected the token (401)"))
        os.environ["JIRA_SPRINT_SERVER"] = "http://127.0.0.1:1"
        code, _, err = self.run_helper("snapshot")
        self.assertEqual(code, 1)
        self.assertTrue(err.startswith("cannot reach Jira"), err)

    def test_locked_vault_exits_3_without_asking_rbw_for_the_secret(self):
        del os.environ["JIRA_SPRINT_TOKEN"]
        bindir = os.path.join(HERE, "__fakebin__")
        os.makedirs(bindir, exist_ok=True)
        self.addCleanup(lambda: __import__("shutil").rmtree(bindir))
        log = os.path.join(bindir, "calls")
        with open(os.path.join(bindir, "rbw"), "w") as f:
            f.write(f"#!/bin/sh\necho \"$1\" >> {log}\n[ \"$1\" = unlocked ] && exit 1\necho leaked\n")
        os.chmod(os.path.join(bindir, "rbw"), 0o755)
        old_path = os.environ["PATH"]
        os.environ["PATH"] = bindir + os.pathsep + old_path
        self.addCleanup(os.environ.__setitem__, "PATH", old_path)
        code, _, err = self.run_helper("snapshot")
        self.assertEqual((code, err), (3, "vault locked"))
        with open(log) as f:
            self.assertEqual(f.read().split(), ["unlocked"])

    def test_sprint_days_left(self):
        raw = [{"fields": {"customfield_10020": [
            {"state": "closed", "name": "old", "endDate": "2026-11-01T00:00:00.000Z"},
            {"state": "active", "name": "now", "endDate": "2026-11-23T00:00:00.000Z"}]}}]
        now = datetime(2026, 11, 18, 21, 0, tzinfo=timezone.utc)
        self.assertEqual(jirasprint.active_sprint(raw, now), {"name": "now", "days_left": 4})

    def test_unknown_statuses_sort_inside_their_category(self):
        mk = lambda s, c: {"status": s, "category": c}
        groups = jirasprint.group([mk("Done", "done"), mk("Zeta", "indeterminate"),
                                   mk("Untriaged", "new"), mk("In Review", "indeterminate")])
        self.assertEqual([g["status"] for g in groups], ["In Review", "Zeta", "Untriaged", "Done"])


if __name__ == "__main__":
    unittest.main()
