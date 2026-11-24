import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

export const VIEWS = ['mine', 'team', 'backlog'];
const VIEW_LABELS = {mine: 'MY SPRINT', team: 'TEAM SPRINT', backlog: 'BACKLOG'};
const TYPE_GLYPHS = {Bug: '●', Task: '■', Story: '▲', Epic: '◆'};

const SLIDE_MS = 200;
const HEIGHT_FRACTION = 0.72;
const MIN_HEIGHT = 560;
const TRANSITIONS_PER_ROW = 4;

function fmtAgo(seconds) {
    const ago = Math.max(0, Math.round(GLib.get_real_time() / 1e6 - seconds));
    if (ago < 60)
        return 'just now';
    if (ago < 3600)
        return `${Math.round(ago / 60)} min ago`;
    return `${Math.round(ago / 3600)} h ago`;
}

/**
 * Drop-down console: the ticket list on the left, the selected ticket on
 * the right. Takes a modal grab while open; Escape or a click outside closes.
 */
export class Dropdown {
    constructor(callbacks) {
        this._callbacks = callbacks;
        this._open = false;
        this._grab = null;
        this._data = null;
        this._signature = null;
        this._view = 'mine';
        this._status = {busy: false, error: null, locked: false};
        this._rows = [];
        this._issues = [];
        this._selectedKey = null;
        this._detailKey = null;
        this._transitionButtons = [];
        this._build();
    }

    get isOpen() {
        return this._open;
    }

    get selectedKey() {
        return this._selectedKey;
    }

    _build() {
        this._scrim = new St.Widget({
            style_class: 'jsp-scrim',
            reactive: true,
            visible: false,
            opacity: 0,
        });
        // Presses inside must keep propagating, or St.Button never clicks.
        this._scrim.connect('button-press-event', (_actor, event) => {
            if (this._panel.contains(global.stage.get_event_actor(event)))
                return Clutter.EVENT_PROPAGATE;
            this.close();
            return Clutter.EVENT_STOP;
        });
        this._scrim.connect('key-press-event', (_actor, event) => this._onKey(event));

        this._clip = new St.Widget({clip_to_allocation: true});
        this._scrim.add_child(this._clip);

        this._panel = new St.BoxLayout({
            style_class: 'jsp-panel',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._clip.add_child(this._panel);

        this._panel.add_child(this._buildHeader());

        const body = new St.BoxLayout({style_class: 'jsp-body', x_expand: true, y_expand: true});
        this._panel.add_child(body);

        this._list = new St.BoxLayout({
            style_class: 'jsp-list',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
        });
        this._listScroll = new St.ScrollView({
            style_class: 'jsp-list-scroll',
            child: this._list,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
        });
        body.add_child(this._listScroll);

        body.add_child(this._buildDetail());
        this._panel.add_child(this._buildFooter());

        Main.layoutManager.uiGroup.add_child(this._scrim);
        this._syncChecked();
    }

    _button(text, styleClass, onClick) {
        const button = new St.Button({
            label: text,
            style_class: `jsp-button ${styleClass}`,
            can_focus: false,
        });
        button.connect('clicked', onClick);
        return button;
    }

    _wrapped(styleClass) {
        const label = new St.Label({style_class: styleClass, x_expand: true});
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        return label;
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'jsp-header'});
        header.add_child(new St.Label({
            text: '◢ JIRA',
            style_class: 'jsp-title',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const tabs = new St.BoxLayout({style_class: 'jsp-group'});
        this._viewButtons = VIEWS.map((view, i) => {
            const button = this._button(`${i + 1} ${VIEW_LABELS[view]}`, 'jsp-tab',
                () => this._callbacks.onView(view));
            tabs.add_child(button);
            return button;
        });
        header.add_child(tabs);
        this._sprintLabel = new St.Label({
            style_class: 'jsp-sprint',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._sprintLabel);
        header.add_child(new St.Widget({x_expand: true}));
        this._statusLabel = new St.Label({
            style_class: 'jsp-status',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._statusLabel);
        this._unlockButton = this._button('UNLOCK VAULT', 'jsp-action',
            () => this._callbacks.onUnlock());
        this._unlockButton.visible = false;
        header.add_child(this._unlockButton);
        return header;
    }

    _buildDetail() {
        const detail = new St.BoxLayout({
            style_class: 'jsp-detail',
            orientation: Clutter.Orientation.VERTICAL,
            // Set explicitly: its expanding children would otherwise make it
            // share the spare width with the list.
            x_expand: false,
            y_expand: true,
        });
        this._detailKeyLabel = new St.Label({style_class: 'jsp-detail-key'});
        this._detailTitle = this._wrapped('jsp-detail-title');
        this._detailMeta = this._wrapped('jsp-dim');
        detail.add_child(this._detailKeyLabel);
        detail.add_child(this._detailTitle);
        detail.add_child(this._detailMeta);

        this._actions = new St.BoxLayout({style_class: 'jsp-group jsp-actions'});
        this._openButton = this._button('OPEN IN BROWSER', 'jsp-action', () => this._openSelected());
        this._copyButton = this._button('COPY KEY', 'jsp-action', () => this._copySelected());
        this._actions.add_child(this._openButton);
        this._actions.add_child(this._copyButton);
        detail.add_child(this._actions);

        detail.add_child(new St.Label({text: 'MOVE TO', style_class: 'jsp-caption'}));
        this._transitions = new St.BoxLayout({
            style_class: 'jsp-group',
            orientation: Clutter.Orientation.VERTICAL,
        });
        detail.add_child(this._transitions);

        this._detailText = this._wrapped('jsp-detail-text');
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        box.add_child(this._detailText);
        this._detailScroll = new St.ScrollView({
            child: box,
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
            overlay_scrollbars: true,
        });
        detail.add_child(this._detailScroll);
        this._detail = detail;
        return detail;
    }

    _buildFooter() {
        const footer = new St.BoxLayout({style_class: 'jsp-footer'});
        footer.add_child(new St.Label({
            text: '↑/↓ select  ·  Enter open in browser  ·  C copy key  ·  1-3 view  ·  R refresh  ·  Esc close',
            style_class: 'jsp-hint',
            x_expand: true,
        }));
        this._totalsLabel = new St.Label({style_class: 'jsp-hint'});
        footer.add_child(this._totalsLabel);
        return footer;
    }

    _onKey(event) {
        const symbol = event.get_key_symbol();
        switch (symbol) {
        case Clutter.KEY_Escape:
            this.close();
            break;
        case Clutter.KEY_Up:
        case Clutter.KEY_k:
            this._step(-1);
            break;
        case Clutter.KEY_Down:
        case Clutter.KEY_j:
            this._step(1);
            break;
        case Clutter.KEY_Return:
        case Clutter.KEY_KP_Enter:
            this._openSelected();
            break;
        case Clutter.KEY_c:
        case Clutter.KEY_C:
            this._copySelected();
            break;
        case Clutter.KEY_Tab:
            this._callbacks.onView(VIEWS[(VIEWS.indexOf(this._view) + 1) % VIEWS.length]);
            break;
        case Clutter.KEY_r:
        case Clutter.KEY_R:
            this._callbacks.onRefresh();
            break;
        default: {
            const index = symbol - Clutter.KEY_1;
            if (index >= 0 && index < VIEWS.length)
                this._callbacks.onView(VIEWS[index]);
            else
                return Clutter.EVENT_PROPAGATE;
        }
        }
        return Clutter.EVENT_STOP;
    }

    _step(delta) {
        if (!this._issues.length)
            return;
        const current = this._issues.findIndex(issue => issue.key === this._selectedKey);
        const next = Math.min(Math.max(current + delta, 0), this._issues.length - 1);
        this._select(this._issues[next].key);
    }

    _url(key) {
        return `${this._data.server}/browse/${key}`;
    }

    _openSelected() {
        if (!this._selectedKey || !this._data)
            return;
        this._callbacks.onOpenUrl(this._url(this._selectedKey));
        this.close();
    }

    _copySelected() {
        if (!this._selectedKey)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, this._selectedKey);
        this._copyButton.label = 'COPIED';
    }

    _syncChecked() {
        this._viewButtons.forEach((button, i) => {
            if (VIEWS[i] === this._view)
                button.add_style_pseudo_class('checked');
            else
                button.remove_style_pseudo_class('checked');
        });
    }

    setView(view) {
        this._view = view;
        this._syncChecked();
    }

    setStatus(status) {
        this._status = status;
        this._renderStatus();
    }

    setData(data) {
        this._data = data;
        this._render();
        this._renderStatus();
    }

    _render() {
        const data = this._data;
        // Rebuilding resets the scroll position, so only do it for real changes.
        const signature = JSON.stringify([data.view, data.groups]);
        if (signature === this._signature)
            return;
        this._signature = signature;

        this._list.destroy_all_children();
        this._rows = [];
        this._issues = [];
        const showAssignee = data.view !== 'mine';
        for (const group of data.groups) {
            this._list.add_child(new St.Label({
                text: `${group.status.toUpperCase()}  ${group.issues.length}`,
                style_class: `jsp-caption jsp-group-${group.category}`,
            }));
            for (const issue of group.issues) {
                const row = this._buildRow(issue, showAssignee);
                this._list.add_child(row);
                this._rows.push(row);
                this._issues.push(issue);
            }
        }
        if (!this._issues.length) {
            this._list.add_child(new St.Label({
                text: 'Nothing here.',
                style_class: 'jsp-empty',
            }));
        }

        const sprint = data.sprint;
        this._sprintLabel.text = sprint
            ? `${sprint.name}${sprint.days_left === null ? '' : `  ·  ${sprint.days_left} d left`}`
            : '';
        const done = data.view === 'backlog' ? '' : `  ·  ${data.done} done (${data.points_done} pts)`;
        this._totalsLabel.text = `${data.open} open (${data.points_open} pts)${done}`;

        const keep = this._issues.some(issue => issue.key === this._selectedKey);
        this._select(keep ? this._selectedKey : this._issues[0]?.key ?? null, {force: true});
    }

    _buildRow(issue, showAssignee) {
        const box = new St.BoxLayout({style_class: 'jsp-row-box', x_expand: true});
        box.add_child(new St.Label({
            text: TYPE_GLYPHS[issue.type] ?? '·',
            style_class: `jsp-type jsp-type-${issue.type.toLowerCase().replace(/[^a-z]/g, '')}`,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            text: issue.key,
            style_class: 'jsp-key',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(new St.Label({
            text: issue.summary,
            style_class: 'jsp-summary',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        if (showAssignee) {
            box.add_child(new St.Label({
                text: issue.assignee || 'unassigned',
                style_class: 'jsp-dim',
                y_align: Clutter.ActorAlign.CENTER,
            }));
        }
        box.add_child(new St.Label({
            text: issue.points === null ? '' : `${issue.points}`,
            style_class: 'jsp-points',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        const row = new St.Button({
            child: box,
            style_class: `jsp-row jsp-row-${issue.category}`,
            can_focus: false,
            x_expand: true,
        });
        row.connect('clicked', () => this._select(issue.key));
        return row;
    }

    _select(key, {force = false} = {}) {
        if (key === this._selectedKey && !force)
            return;
        this._selectedKey = key;
        this._rows.forEach((row, i) => {
            if (this._issues[i].key === key) {
                row.add_style_pseudo_class('selected');
                if (this._open)
                    ensureActorVisibleInScrollView(this._listScroll, row);
            } else {
                row.remove_style_pseudo_class('selected');
            }
        });
        this._renderDetailHead();
        if (key && key !== this._detailKey) {
            this._detailKey = null;
            this._detailText.text = 'loading…';
            this._setTransitions([]);
            if (this._open)
                this._callbacks.onSelect(key);
        }
    }

    _renderDetailHead() {
        const issue = this._issues.find(i => i.key === this._selectedKey);
        this._detail.opacity = issue ? 255 : 0;
        if (!issue)
            return;
        this._copyButton.label = 'COPY KEY';
        this._detailKeyLabel.text = `${issue.key}  ·  ${issue.status}`;
        this._detailTitle.text = issue.summary;
        this._detailMeta.text = [
            issue.type,
            issue.priority,
            issue.points === null ? null : `${issue.points} pts`,
            issue.assignee || 'unassigned',
            issue.parent ? `in ${issue.parent}` : null,
            `updated ${issue.updated.slice(0, 10)}`,
        ].filter(Boolean).join('  ·  ');
    }

    _setTransitions(transitions) {
        this._transitions.destroy_all_children();
        const issue = this._issues.find(i => i.key === this._selectedKey);
        const key = this._selectedKey;
        let row = null;
        this._transitionButtons = transitions
            .filter(t => t.name.toLowerCase() !== issue?.status.toLowerCase())
            .map((t, i) => {
                if (i % TRANSITIONS_PER_ROW === 0) {
                    row = new St.BoxLayout({style_class: 'jsp-group'});
                    this._transitions.add_child(row);
                }
                const button = this._button(t.name.toUpperCase(), 'jsp-move',
                    () => this._callbacks.onMove(key, t.id));
                row.add_child(button);
                return button;
            });
    }

    /** Answer to onSelect: the ticket's text and where it can move. */
    setDetail(key, detail, error = null) {
        if (key !== this._selectedKey)
            return;
        if (error) {
            this._detailText.text = `could not load: ${error}`;
            return;
        }
        this._detailKey = key;
        this._setTransitions(detail.transitions);
        const parts = [detail.description.trim() || '(no description)'];
        for (const comment of detail.comments)
            parts.push(`── ${comment.author}, ${comment.created} ──\n${comment.body.trim()}`);
        this._detailText.text = parts.join('\n\n');
        this._detailScroll.vadjustment.value = 0;
    }

    /** Forget the loaded ticket, so the next selection asks again. */
    invalidateDetail() {
        this._detailKey = null;
    }

    _renderStatus() {
        const {busy, error, locked} = this._status;
        this._unlockButton.visible = locked;
        if (locked)
            this._statusLabel.text = 'vault locked';
        else if (error)
            this._statusLabel.text = error;
        else if (busy)
            this._statusLabel.text = 'working…';
        else if (this._data)
            this._statusLabel.text = `updated ${fmtAgo(this._data.fetched_at)}`;
        else
            this._statusLabel.text = '';
    }

    toggle() {
        if (this._open)
            this.close();
        else
            this.open();
    }

    open() {
        if (this._open)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const top = Main.panel.height;
        const height = Math.round(Math.min(
            Math.max(monitor.height * HEIGHT_FRACTION, MIN_HEIGHT),
            monitor.height - top - 24));
        this._scrim.set_position(monitor.x, monitor.y);
        this._scrim.set_size(monitor.width, monitor.height);
        this._clip.set_position(0, top);
        this._clip.set_size(monitor.width, height);
        this._panel.set_size(monitor.width, height);
        this._detail.set_width(Math.round(monitor.width * 0.42));
        this._height = height;

        // POPUP keeps our own toggle shortcut live while the grab is held.
        this._grab = Main.pushModal(this._scrim, {actionMode: Shell.ActionMode.POPUP});
        this._open = true;

        Main.layoutManager.uiGroup.set_child_above_sibling(this._scrim, null);
        this._scrim.show();
        this._scrim.ease({
            opacity: 255,
            duration: SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._panel.translation_y = -height;
        this._panel.ease({
            translation_y: 0,
            duration: SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this._renderStatus();
        this._callbacks.onOpen();
        if (this._selectedKey && this._selectedKey !== this._detailKey)
            this._callbacks.onSelect(this._selectedKey);
    }

    close() {
        if (!this._open)
            return;
        this._open = false;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._scrim.ease({
            opacity: 0,
            duration: SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
        this._panel.ease({
            translation_y: -this._height,
            duration: SLIDE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onStopped: () => {
                if (!this._open)
                    this._scrim?.hide();
            },
        });
    }

    destroy() {
        this._open = false;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._scrim.destroy();
        this._scrim = null;
    }
}
