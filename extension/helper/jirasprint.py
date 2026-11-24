#!/usr/bin/env python3
"""Jira access for the Jira Sprint extension. Standard library only.

The shell never talks to Jira itself: it runs this script, which prints one
JSON document on stdout, or one line of reason on stderr and a non-zero exit.
Exit 3 means the Bitwarden vault is locked; the shell offers to unlock it.

Server and login come from jira-cli's configuration, the token from rbw at
the moment of use. JIRA_SPRINT_SERVER, JIRA_SPRINT_LOGIN and JIRA_SPRINT_TOKEN
override all three, for tests against a local mock.
"""
import argparse
import base64
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

EXIT_LOCKED = 3
STORY_POINTS = "customfield_10024"
SPRINT = "customfield_10020"
FIELDS = ["summary", "status", "issuetype", "assignee", "priority", "parent",
          "updated", STORY_POINTS, SPRINT]
# Board order within a status category; unknown statuses sort after these.
STATUS_ORDER = ["In Progress", "In Review", "To Be Deployed", "BLOCKED",
                "Triaged", "Untriaged"]
CATEGORY_ORDER = {"indeterminate": 0, "new": 1, "done": 2}
MAX_PAGES = 5


class Failure(Exception):
    def __init__(self, reason, code=1):
        super().__init__(reason)
        self.code = code


def cli_config():
    """server and login from jira-cli's YAML, read without a YAML parser."""
    path = os.environ.get("JIRA_CONFIG_FILE") or os.path.expanduser(
        "~/.config/.jira/.config.yml")
    found = {}
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                m = re.match(r"^(server|login):\s*(\S+)\s*$", line)
                if m:
                    found[m.group(1)] = m.group(2).strip("'\"")
    except OSError:
        pass
    return found


def settings():
    cfg = cli_config()
    server = os.environ.get("JIRA_SPRINT_SERVER") or cfg.get("server")
    login = os.environ.get("JIRA_SPRINT_LOGIN") or cfg.get("login")
    if not server or not login:
        raise Failure("jira-cli is not configured (no server or login in ~/.config/.jira/.config.yml)")
    return server.rstrip("/"), login


def token(item):
    env = os.environ.get("JIRA_SPRINT_TOKEN")
    if env:
        return env
    try:
        # `rbw unlocked` only reports; `rbw get` on a locked vault would raise
        # a pinentry from a background refresh.
        if subprocess.run(["rbw", "unlocked"], capture_output=True).returncode != 0:
            raise Failure("vault locked", EXIT_LOCKED)
        got = subprocess.run(["rbw", "get", "--", item], capture_output=True, text=True)
    except FileNotFoundError:
        raise Failure("rbw is not installed") from None
    if got.returncode != 0:
        raise Failure((got.stderr.strip().splitlines() or ["rbw get failed"])[-1])
    value = got.stdout.strip()
    if not value:
        raise Failure(f"the rbw item '{item}' has an empty password")
    return value


class Jira:
    def __init__(self, server, login, secret):
        self.server = server
        auth = base64.b64encode(f"{login}:{secret}".encode()).decode()
        self.headers = {"Authorization": f"Basic {auth}", "Accept": "application/json",
                        "Content-Type": "application/json"}

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.server + path, data=data, method=method,
                                     headers=self.headers)
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            detail = ""
            with e:  # the error carries an open response body
                try:
                    err = json.loads(e.read())
                    msgs = list(err.get("errorMessages") or []) + list((err.get("errors") or {}).values())
                    detail = ": " + "; ".join(str(m) for m in msgs) if msgs else ""
                except (ValueError, OSError):
                    pass
            if e.code == 401:
                raise Failure("Jira rejected the token (401)") from None
            raise Failure(f"Jira answered {e.code}{detail}") from None
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise Failure(f"cannot reach Jira: {getattr(e, 'reason', e)}") from None
        return json.loads(raw) if raw else None

    def search(self, jql):
        issues, page_token = [], None
        for _ in range(MAX_PAGES):
            body = {"jql": jql, "fields": FIELDS, "maxResults": 100}
            if page_token:
                body["nextPageToken"] = page_token
            page = self.call("POST", "/rest/api/3/search/jql", body)
            issues += page.get("issues") or []
            page_token = page.get("nextPageToken")
            if not page_token:
                break
        return issues


def jql_for(view, team):
    if view == "mine":
        return "sprint in openSprints() AND assignee = currentUser() ORDER BY Rank"
    if not team:
        raise Failure("set the team-id setting to use the team and backlog views")
    if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", team):
        raise Failure("team-id is not a Jira Team id")
    if view == "team":
        return f'sprint in openSprints() AND "Team[Team]" = {team} ORDER BY Rank'
    return f'sprint is EMPTY AND "Team[Team]" = {team} AND statusCategory != Done ORDER BY Rank'


def brief(issue):
    f = issue["fields"]
    status = f.get("status") or {}
    points = f.get(STORY_POINTS)
    return {
        "key": issue["key"],
        "summary": f.get("summary") or "",
        "status": status.get("name") or "?",
        "category": (status.get("statusCategory") or {}).get("key") or "new",
        "type": (f.get("issuetype") or {}).get("name") or "",
        "assignee": (f.get("assignee") or {}).get("displayName") or "",
        "priority": (f.get("priority") or {}).get("name") or "",
        "parent": ((f.get("parent") or {}).get("fields") or {}).get("summary") or "",
        "points": points,
        "updated": f.get("updated") or "",
    }


def group(issues):
    by_status = {}
    for issue in issues:
        by_status.setdefault(issue["status"], []).append(issue)

    def rank(name):
        category = by_status[name][0]["category"]
        order = STATUS_ORDER.index(name) if name in STATUS_ORDER else len(STATUS_ORDER)
        return (CATEGORY_ORDER.get(category, 1), order, name.lower())

    return [{"status": name, "category": by_status[name][0]["category"],
             "issues": by_status[name]} for name in sorted(by_status, key=rank)]


def active_sprint(raw_issues, now):
    for issue in raw_issues:
        for sprint in issue["fields"].get(SPRINT) or []:
            if sprint.get("state") != "active":
                continue
            days = None
            try:
                end = datetime.fromisoformat(sprint["endDate"].replace("Z", "+00:00"))
                days = max(0, (end - now).days)
            except (KeyError, ValueError, AttributeError):
                pass
            return {"name": sprint.get("name") or "", "days_left": days}
    return None


def snapshot(jira, view, team, now=None):
    now = now or datetime.now(timezone.utc)
    raw = jira.search(jql_for(view, team))
    issues = [brief(i) for i in raw]
    done = [i for i in issues if i["category"] == "done"]
    return {
        "view": view,
        "server": jira.server,
        "sprint": active_sprint(raw, now) if view != "backlog" else None,
        "groups": group(issues),
        "open": len(issues) - len(done),
        "done": len(done),
        "points_open": sum(i["points"] or 0 for i in issues if i["category"] != "done"),
        "points_done": sum(i["points"] or 0 for i in done),
        "fetched_at": int(now.timestamp()),
    }


def detail(jira, key):
    quoted = urllib.parse.quote(key, safe="")
    # API v2 returns the description and comments as text, v3 as a document tree.
    issue = jira.call("GET", f"/rest/api/2/issue/{quoted}?fields=description,comment")
    fields = issue.get("fields") or {}
    comments = ((fields.get("comment") or {}).get("comments") or [])[-5:]
    transitions = jira.call("GET", f"/rest/api/3/issue/{quoted}/transitions")
    return {
        "key": key,
        "description": fields.get("description") or "",
        "comments": [{"author": (c.get("author") or {}).get("displayName") or "",
                      "created": (c.get("created") or "")[:10],
                      "body": c.get("body") or ""} for c in comments],
        "transitions": [{"id": t["id"], "name": t["name"]}
                        for t in transitions.get("transitions") or []],
    }


def move(jira, key, transition):
    quoted = urllib.parse.quote(key, safe="")
    jira.call("POST", f"/rest/api/3/issue/{quoted}/transitions",
              {"transition": {"id": transition}})
    return {"key": key, "moved": True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--rbw-item", default="jira api key")
    sub = parser.add_subparsers(dest="command", required=True)
    snap = sub.add_parser("snapshot")
    snap.add_argument("--view", choices=["mine", "team", "backlog"], default="mine")
    snap.add_argument("--team", default="")
    sub.add_parser("issue").add_argument("key")
    mv = sub.add_parser("move")
    mv.add_argument("key")
    mv.add_argument("transition")
    args = parser.parse_args(argv)
    try:
        if getattr(args, "key", None) and not re.fullmatch(r"[A-Z][A-Z0-9_]*-\d+", args.key):
            raise Failure("not an issue key")
        server, login = settings()
        jira = Jira(server, login, token(args.rbw_item))
        if args.command == "snapshot":
            out = snapshot(jira, args.view, args.team)
        elif args.command == "issue":
            out = detail(jira, args.key)
        else:
            out = move(jira, args.key, args.transition)
    except Failure as e:
        print(e, file=sys.stderr)
        return e.code
    json.dump(out, sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
