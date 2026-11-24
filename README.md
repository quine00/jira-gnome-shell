# Jira Sprint - GNOME Shell extension

Top-bar count of my open sprint tickets plus a drop-down console to read
and move them, so the Jira web UI stays closed.

## Use

- Click `J <n>` in the top bar, or press `Super+J`.
- `1`-`3` (or Tab) switch view: my sprint, team sprint, team backlog.
- `Up`/`Down` (or `k`/`j`) select a ticket; its description, last five
  comments and possible moves load on the right.
- Click a MOVE TO button to transition the ticket.
- `Enter` opens the ticket in the browser, `C` copies its key, `R`
  refreshes, `Esc` or a click outside closes.

## Install

    make install     # pack, install, enable (GNOME Shell 51); then log out and in
    make test        # helper unit tests against a mock Jira
    make e2e         # drives the real UI in a headless shell against the mock

The team and backlog views need the Jira Team id:

    gsettings --schemadir ~/.local/share/gnome-shell/extensions/jira-sprint@charles.local/schemas \
        set org.gnome.shell.extensions.jira-sprint team-id <uuid>

Other keys: `toggle-dropdown`, `sync-interval` (seconds, default 300),
`rbw-item` (default `jira api key`).

## How it works

    extension.js  --spawns-->  helper/jirasprint.py  --HTTPS-->  Jira Cloud REST

The shell never talks to Jira or holds the token. Each refresh runs the
Python helper (standard library only), which prints one JSON document.

- **Server and login** come from jira-cli's `~/.config/.jira/.config.yml`.
- **Token** comes from `rbw get "jira api key"` at the moment of use. The
  helper first asks `rbw unlocked`, which never prompts; with a locked
  vault the bar shows `J 🔒` and the drop-down an UNLOCK VAULT button,
  which runs `rbw unlock` (the pinentry dialog) and refreshes.
- **My sprint** is `sprint in openSprints() AND assignee = currentUser()`,
  across projects. The team views filter on `"Team[Team]"`.
- Story Points is `customfield_10024` and Sprint `customfield_10020`
  (constants at the top of the helper).

## Not done

- Creating tickets, commenting, editing fields, adding to a sprint: use
  `jnew`, `jc`, `jadd` from the shell, or the browser.
- Descriptions and comments are shown as Jira's wiki text, unrendered.
