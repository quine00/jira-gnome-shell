import Gio from 'gi://Gio';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async');

const EXIT_LOCKED = 3;

/** Runs the Python helper; all network and secret access happens out of process. */
export class Helper {
    constructor(script, rbwItem) {
        this._script = script;
        this._rbwItem = rbwItem;
        this._cancellable = new Gio.Cancellable();
    }

    snapshot(view, team) {
        return this._run(['snapshot', '--view', view, '--team', team]);
    }

    issue(key) {
        return this._run(['issue', key]);
    }

    move(key, transition) {
        return this._run(['move', key, transition]);
    }

    /** `rbw unlock` raises the pinentry dialog; resolves to whether it unlocked. */
    async unlock() {
        const proc = Gio.Subprocess.new(['rbw', 'unlock'], Gio.SubprocessFlags.STDERR_SILENCE);
        await proc.wait_async(this._cancellable);
        return proc.get_successful();
    }

    async _run(args) {
        const argv = ['python3', this._script, '--rbw-item', this._rbwItem, ...args];
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        const [stdout, stderr] = await proc.communicate_utf8_async(null, this._cancellable);
        if (!proc.get_successful()) {
            const error = new Error(stderr.trim().split('\n').pop() || 'helper failed');
            error.locked = proc.get_if_exited() && proc.get_exit_status() === EXIT_LOCKED;
            throw error;
        }
        return JSON.parse(stdout);
    }

    destroy() {
        this._cancellable.cancel();
    }
}
