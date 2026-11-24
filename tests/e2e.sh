#!/bin/bash
# End-to-end test: boots a headless GNOME Shell with its own D-Bus session,
# config and data dirs, loads the extension from this tree against a mock
# Jira, then drives it with a virtual pointer and keyboard. `make e2e`.
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
UUID=jira-sprint@charles.local
WORK=$(mktemp -d)
trap 'rm -r "$WORK"' EXIT

if [ "${1:-}" != --inside ]; then
    ext="$WORK/data/gnome-shell/extensions"
    mkdir -p "$ext/unsafe@test" "$WORK/config" "$WORK/cache" "$WORK/schemas"
    ln -s "$ROOT/extension" "$ext/$UUID"
    glib-compile-schemas --targetdir "$WORK/schemas" "$ROOT/extension/schemas"
    # getSettings() reads the extension's own schemas directory first.
    glib-compile-schemas "$ROOT/extension/schemas"
    # Eval over D-Bus needs unsafe mode; a helper extension switches it on.
    echo '{"uuid":"unsafe@test","name":"t","description":"t","shell-version":["51"]}' \
        > "$ext/unsafe@test/metadata.json"
    cat > "$ext/unsafe@test/extension.js" <<'JS'
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
export default class Unsafe extends Extension {
    enable() { global.context.unsafe_mode = true; }
    disable() {}
}
JS
    python3 "$ROOT/tests/mockjira.py" "$WORK/port" "$WORK/moves" &
    mock=$!
    for _ in $(seq 50); do [ -s "$WORK/port" ] && break; sleep 0.1; done
    export XDG_DATA_HOME="$WORK/data" XDG_CONFIG_HOME="$WORK/config" XDG_CACHE_HOME="$WORK/cache"
    export JIRA_SPRINT_SERVER="http://127.0.0.1:$(cat "$WORK/port")"
    export JIRA_SPRINT_LOGIN=me@example.com JIRA_SPRINT_TOKEN=secret
    export E2E_WORK="$WORK"
    unset WAYLAND_DISPLAY DISPLAY
    trap - EXIT
    dbus-run-session -- "$0" --inside 2> "$WORK/session.log"
    status=$?
    kill $mock
    [ $status -eq 0 ] || grep -E "JS ERROR|\.js:[0-9]" "$WORK/shell.log"
    rm -r "$WORK"
    exit $status
fi

trap - EXIT
WORK=$E2E_WORK
gsettings set org.gnome.shell disable-user-extensions false
gsettings set org.gnome.shell enabled-extensions "['unsafe@test', '$UUID']"
gsettings set org.gnome.shell welcome-dialog-last-shown-version 99
GSETTINGS_SCHEMA_DIR="$WORK/schemas" gsettings set org.gnome.shell.extensions.jira-sprint \
    team-id 8b7e057e-d4d3-4dfc-a741-8a7c4521cf82
GSETTINGS_SCHEMA_DIR="$WORK/schemas" gnome-shell --headless --wayland-display jsp-e2e \
    --virtual-monitor 1920x1080 > "$WORK/shell.log" 2>&1 &
shell=$!
trap 'kill $shell; wait $shell 2>/dev/null' EXIT

ev() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1"
}
for _ in $(seq 30); do
    ev 1 2>/dev/null | grep -q true && break
    sleep 0.5
done

X="Main.extensionManager.lookup('$UUID').stateObj"
D="$X._dropdown"
C=imports.gi.Clutter
ev "Main.overview.hide();
    const seat = global.stage.context.get_backend().get_default_seat();
    globalThis.vp = seat.create_virtual_device($C.InputDeviceType.POINTER_DEVICE);
    globalThis.vk = seat.create_virtual_device($C.InputDeviceType.KEYBOARD_DEVICE); 1" > /dev/null
sleep 2

click_actor() { # click the centre of the actor a JS expression evaluates to
    ev "const [x, y] = ($1).get_transformed_position(); const [w, h] = ($1).get_transformed_size();
        vp.notify_absolute_motion(global.get_current_time(), x + w / 2, y + h / 2); 1" > /dev/null
    press
}
click_at() {
    ev "vp.notify_absolute_motion(global.get_current_time(), $1, $2); 1" > /dev/null
    press
}
press() {
    sleep 0.3
    ev "vp.notify_button(global.get_current_time(), $C.BUTTON_PRIMARY, $C.ButtonState.PRESSED); 1" > /dev/null
    sleep 0.1
    ev "vp.notify_button(global.get_current_time(), $C.BUTTON_PRIMARY, $C.ButtonState.RELEASED); 1" > /dev/null
    sleep 0.6
}
key() {
    ev "vk.notify_keyval(global.get_current_time(), $C.$1, $C.KeyState.PRESSED);
        vk.notify_keyval(global.get_current_time(), $C.$1, $C.KeyState.RELEASED); 1" > /dev/null
    sleep 0.6
}

failures=0
expect() { # description, JS expression, expected value; waits up to 6 s for it
    local got
    for _ in $(seq 20); do
        got=$(ev "String($2)")
        [[ $got == "(true, '\"$3\"')" ]] && { echo "ok   $1"; return; }
        sleep 0.3
    done
    echo "FAIL $1: expected '$3', got $got"
    failures=$((failures + 1))
}
STATE="[$D.isOpen, $D._view, $D._rows.length, $D.selectedKey, $D._detailKey].join(' ')"
LABEL="Main.panel.statusArea['$UUID']._label.text"

expect "indicator counts my open tickets" "$LABEL" "J 3"
expect "starts closed, list already filled" "$STATE" "false mine 4 T-1 "
click_actor "Main.panel.statusArea['$UUID']"
expect "indicator click opens and loads the first ticket" "$STATE" "true mine 4 T-1 T-1"
expect "the detail column keeps its 42% width" \
    "Math.round($D._detail.get_transformed_size()[0])" "806"
expect "groups follow the board order" \
    "$D._data.groups.map(g => g.status + ':' + g.issues.length).join(' ')" \
    "In Progress:1 In Review:1 Triaged:1 Done:1"
expect "detail shows description and comments" \
    "$D._detailText.text.split(String.fromCharCode(10)).filter(Boolean).join(' | ')" \
    "Description of T-1. | ── Nathan, 2026-11-17 ── | A comment on T-1."
expect "moves exclude the current status" \
    "$D._transitionButtons.map(b => b.label).join(',')" "TRIAGED,IN REVIEW,DONE"
click_actor "$D._rows[2]"
expect "row click selects and loads it" "$STATE" "true mine 4 T-2 T-2"
key KEY_Up
expect "arrow key moves the selection" "$STATE" "true mine 4 T-3 T-3"
key KEY_Down
expect "and back" "$STATE" "true mine 4 T-2 T-2"
click_actor "$D._transitionButtons[0]"
expect "move button transitions the ticket in Jira" \
    "JSON.parse(new TextDecoder().decode(imports.gi.GLib.file_get_contents('$WORK/moves')[1])).join(' ')" \
    "T-2 21"
expect "the list regroups after the move" \
    "$D._data.groups.map(g => g.status + ':' + g.issues.length).join(' ')" \
    "In Progress:2 In Review:1 Done:1"
expect "selection survives the move and its moves refresh" \
    "$D.selectedKey + ' ' + $D._transitionButtons.map(b => b.label).join(',')" \
    "T-2 TRIAGED,IN REVIEW,DONE"
key KEY_2
expect "2 switches to the team sprint, keeping the selection" "$STATE" "true team 5 T-2 T-2"
expect "indicator still counts mine" "$LABEL" "J 3"
click_actor "$D._viewButtons[2]"
expect "tab click switches to the backlog" "$STATE" "true backlog 1 T-6 T-6"
key KEY_c
expect "C copies the key" "$D._copyButton.label" "COPIED"
click_actor "$D._detailText"
expect "click inside keeps it open" "$D.isOpen" "true"
key KEY_Escape
expect "Escape closes" "$D.isOpen" "false"
click_actor "Main.panel.statusArea['$UUID']"
expect "reopens" "$D.isOpen" "true"
key KEY_1
expect "1 returns to my sprint" "$STATE" "true mine 4 T-1 T-1"
click_at 960 1060
expect "click outside closes" "$D.isOpen" "false"

if grep -qE "JS ERROR" "$WORK/shell.log"; then
    echo "FAIL JS errors logged"
    failures=$((failures + 1))
fi
exit $failures
