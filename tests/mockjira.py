#!/usr/bin/env python3
"""A tiny Jira Cloud stand-in for the tests: search, issue, transitions."""
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATUSES = {
    "11": ("Triaged", "new"),
    "21": ("In Progress", "indeterminate"),
    "31": ("In Review", "indeterminate"),
    "61": ("Done", "done"),
}
SPRINT = [{"id": 1, "name": "Pulse 2026#22", "state": "active",
           "endDate": "2099-01-01T00:00:00.000Z"}]


def issue(key, summary, status_id, assignee, points, kind="Task"):
    return {"key": key, "summary": summary, "status_id": status_id,
            "assignee": assignee, "points": points, "type": kind}


def fresh_issues():
    return [
        issue("T-1", "pipewire: merge 1.6.11", "21", "me", 3),
        issue("T-2", "wireplumber: heap corruption", "11", "me", 5, "Bug"),
        issue("T-3", "gst: flaky test", "31", "me", None),
        issue("T-4", "old thing", "61", "me", 2),
        issue("T-5", "firefox: regression", "21", "Nathan", 8, "Bug"),
        issue("T-6", "backlog item", "11", "me", None),
    ]


class State:
    def __init__(self):
        self.issues = fresh_issues()
        self.moves = []
        self.auth = []
        self.lock = threading.Lock()


def render(i):
    name, category = STATUSES[i["status_id"]]
    return {"key": i["key"], "fields": {
        "summary": i["summary"],
        "status": {"name": name, "statusCategory": {"key": category}},
        "issuetype": {"name": i["type"]},
        "assignee": {"displayName": "Charles" if i["assignee"] == "me" else i["assignee"]},
        "priority": {"name": "Medium"},
        "parent": {"fields": {"summary": "Maintenance"}},
        "updated": "2026-11-18T10:00:00.000+0000",
        "customfield_10024": i["points"],
        "customfield_10020": None if i["key"] == "T-6" else SPRINT,
    }}


def make_handler(state):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def _send(self, code, body=None):
            raw = json.dumps(body).encode() if body is not None else b""
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _body(self):
            return json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")

        def _authorised(self):
            state.auth.append(self.headers.get("Authorization"))
            if self.headers.get("Authorization") == "Basic bWVAZXhhbXBsZS5jb206YmFk":  # me@example.com:bad
                self._send(401, {"errorMessages": ["no"]})
                return False
            return True

        def do_GET(self):
            if not self._authorised():
                return
            parts = self.path.split("?")[0].strip("/").split("/")
            key = parts[4] if len(parts) > 4 else ""
            with state.lock:
                found = next((i for i in state.issues if i["key"] == key), None)
            if not found:
                self._send(404, {"errorMessages": ["Issue does not exist"]})
            elif parts[-1] == "transitions":
                self._send(200, {"transitions": [{"id": k, "name": v[0]} for k, v in STATUSES.items()]})
            else:
                self._send(200, {"fields": {
                    "description": f"Description of {key}.",
                    "comment": {"comments": [
                        {"author": {"displayName": "Nathan"}, "created": "2026-11-17T09:00:00.000+0000",
                         "body": f"A comment on {key}."}]}}})

        def do_POST(self):
            if not self._authorised():
                return
            body = self._body()
            parts = self.path.strip("/").split("/")
            if self.path == "/rest/api/3/search/jql":
                jql = body["jql"]
                with state.lock:
                    issues = list(state.issues)
                if "sprint is EMPTY" in jql:
                    issues = [i for i in issues if i["key"] == "T-6"]
                else:
                    issues = [i for i in issues if i["key"] != "T-6"]
                    if "currentUser()" in jql:
                        issues = [i for i in issues if i["assignee"] == "me"]
                self._send(200, {"issues": [render(i) for i in issues]})
            elif parts[-1] == "transitions":
                target = body["transition"]["id"]
                with state.lock:
                    found = next((i for i in state.issues if i["key"] == parts[4]), None)
                    if found and target in STATUSES:
                        found["status_id"] = target
                        state.moves.append([parts[4], target])
                self._send(204 if found else 404)
            else:
                self._send(404, {"errorMessages": ["unknown"]})

    return Handler


def serve(port=0):
    state = State()
    server = ThreadingHTTPServer(("127.0.0.1", port), make_handler(state))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, state


if __name__ == "__main__":
    # mockjira.py PORT_FILE MOVES_FILE: write the port, then log moves as JSON lines.
    srv, st = serve()
    with open(sys.argv[1], "w") as f:
        f.write(str(srv.server_address[1]))
    seen = 0
    while True:
        threading.Event().wait(0.2)
        with st.lock:
            new, seen = st.moves[seen:], len(st.moves)
        if new:
            with open(sys.argv[2], "a") as f:
                for m in new:
                    f.write(json.dumps(m) + "\n")
