import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {Dropdown} from './lib/dropdown.js';
import {Helper} from './lib/helper.js';

const TICK_SECONDS = 30;
const KEYBINDING = 'toggle-dropdown';

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(onActivate) {
        super._init(0.5, 'Jira Sprint', true);
        this._label = new St.Label({
            text: 'J …',
            style_class: 'jsp-indicator',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._label);
        this.connect('button-press-event', () => {
            onActivate();
            return Clutter.EVENT_STOP;
        });
        this.connect('touch-event', (_actor, event) => {
            if (event.type() === Clutter.EventType.TOUCH_BEGIN)
                onActivate();
            return Clutter.EVENT_STOP;
        });
    }

    setText(text) {
        this._label.text = text;
    }
});

export default class JiraSprintExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._helper = new Helper(
            this.dir.get_child('helper').get_child('jirasprint.py').get_path(),
            this._settings.get_string('rbw-item'));
        this._running = false;
        this._pending = false;
        this._lastSync = 0;
        this._mine = null;

        this._dropdown = new Dropdown({
            onView: view => this._settings.set_string('view', view),
            onRefresh: () => this._refresh(),
            onOpen: () => this._refresh(),
            onSelect: key => this._loadDetail(key),
            onMove: (key, transition) => this._move(key, transition),
            onUnlock: () => this._unlock(),
            onOpenUrl: url => Gio.AppInfo.launch_default_for_uri(
                url, global.create_app_launch_context(0, -1)),
        });
        this._dropdown.setView(this._view);

        this._indicator = new Indicator(() => this._dropdown.toggle());
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._settings.connectObject(
            'changed::view', () => {
                this._dropdown.setView(this._view);
                this._refresh();
            },
            'changed::team-id', () => this._refresh(),
            this);

        Main.wm.addKeybinding(KEYBINDING, this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._dropdown.toggle());

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
            const due = GLib.get_monotonic_time() / 1e6 - this._lastSync >=
                this._settings.get_uint('sync-interval');
            if (due)
                this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
        this._refresh();
    }

    disable() {
        GLib.source_remove(this._timer);
        this._timer = null;
        Main.wm.removeKeybinding(KEYBINDING);
        this._settings.disconnectObject(this);
        this._helper.destroy();
        this._helper = null;
        this._dropdown.destroy();
        this._dropdown = null;
        this._indicator.destroy();
        this._indicator = null;
        this._settings = null;
        this._mine = null;
    }

    get _view() {
        return this._settings.get_string('view');
    }

    /** One refresh at a time; requests made meanwhile are coalesced. */
    async _refresh() {
        if (this._running) {
            this._pending = true;
            return;
        }
        const helper = this._helper;
        const view = this._view;
        this._running = true;
        this._dropdown.setStatus({busy: true, error: null, locked: false});
        let status = {busy: false, error: null, locked: false};
        try {
            const data = await helper.snapshot(view, this._settings.get_string('team-id'));
            if (this._helper !== helper)
                return; // disabled while the helper was running
            this._lastSync = GLib.get_monotonic_time() / 1e6;
            if (view === this._view)
                this._dropdown.setData(data);
            // The top bar always counts my sprint, whatever view is open.
            if (view === 'mine')
                this._mine = data;
            else if (!this._mine)
                this._mine = await helper.snapshot('mine', '');
            if (this._helper !== helper)
                return;
            this._indicator.setText(`J ${this._mine.open}`);
        } catch (e) {
            if (this._helper !== helper)
                return;
            status = {busy: false, error: e.message, locked: Boolean(e.locked)};
            if (!e.locked)
                console.error(`Jira Sprint: ${e.message}`);
            this._indicator.setText(e.locked ? 'J 🔒' : 'J !');
        } finally {
            this._running = false;
            if (this._helper === helper) {
                const pending = this._pending;
                this._pending = false;
                if (pending)
                    this._refresh();
                else
                    this._dropdown.setStatus(status);
            }
        }
    }

    async _loadDetail(key) {
        const helper = this._helper;
        try {
            const detail = await helper.issue(key);
            if (this._helper === helper)
                this._dropdown.setDetail(key, detail);
        } catch (e) {
            if (this._helper === helper)
                this._dropdown.setDetail(key, null, e.message);
        }
    }

    async _move(key, transition) {
        const helper = this._helper;
        this._dropdown.setStatus({busy: true, error: null, locked: false});
        try {
            await helper.move(key, transition);
            if (this._helper !== helper)
                return;
            this._dropdown.invalidateDetail();
            this._mine = this._view === 'mine' ? this._mine : null;
            await this._refresh();
            if (this._helper === helper && this._dropdown.selectedKey === key)
                this._loadDetail(key);
        } catch (e) {
            if (this._helper === helper)
                this._dropdown.setStatus({busy: false, error: e.message, locked: Boolean(e.locked)});
        }
    }

    /** The pinentry dialog cannot take focus under our modal grab, so close first. */
    async _unlock() {
        const helper = this._helper;
        this._dropdown.close();
        try {
            const unlocked = await helper.unlock();
            if (this._helper !== helper || !unlocked)
                return;
            await this._refresh();
            if (this._helper === helper)
                this._dropdown.open();
        } catch (e) {
            console.error(`Jira Sprint: ${e.message}`);
        }
    }
}
