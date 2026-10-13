import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_window', 'screenshot_window_finish');
const XML = `<node><interface name="co.getoffgridai.Capture">
<signal name="Hotkey"><arg type="s"/></signal>
<method name="WatchShortcut"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="b" direction="out"/></method>
<method name="Focus"><arg type="s" direction="out"/></method>
<method name="Capture"><arg type="u" direction="in"/><arg type="s" direction="out"/></method>
<method name="Paste"><arg type="u" direction="in"/><arg type="b" direction="in"/><arg type="b" direction="out"/></method>
<method name="Activate"><arg type="u" direction="in"/><arg type="b" direction="out"/></method>
</interface></node>`;

export default class OffGridCapture extends Extension {
    enable() {
        this._object = Gio.DBusExportedObject.wrapJSObject(XML, this);
        this._object.export(Gio.DBus.session, '/co/getoffgridai/Capture');
    }
    disable() {
        this._stopShortcut();
        this._object?.unexport();
        this._object = null;
    }
    _releaseShortcut() {
        if (this._stageSignal) global.stage.disconnect(this._stageSignal);
        this._stageSignal = 0;
        if (this._grab) Main.popModal(this._grab);
        this._grab = null;
        this._actor?.destroy();
        this._actor = null;
    }
    _stopShortcut() {
        this._releaseShortcut();
        if (this._acceleratorSignal) global.display.disconnect(this._acceleratorSignal);
        this._acceleratorSignal = 0;
        if (this._accelerator) global.display.ungrab_accelerator(this._accelerator);
        this._accelerator = 0;
        if (this._ownerWatch) Gio.bus_unwatch_name(this._ownerWatch);
        this._ownerWatch = 0;
    }
    WatchShortcutAsync([key, modifier], invocation) {
        this._stopShortcut();
        const symbol = Clutter[`KEY_${key}`];
        if (!symbol || !['Alt', 'Control', 'Super', 'Shift'].includes(modifier)) {
            invocation.return_dbus_error('co.getoffgridai.Capture.Shortcut', 'Unsupported shortcut');
            return;
        }
        this._accelerator = global.display.grab_accelerator(`<${modifier}>${key}`, Meta.KeyBindingFlags.NONE);
        if (!this._accelerator) {
            invocation.return_dbus_error('co.getoffgridai.Capture.Shortcut', 'The shortcut is already in use');
            return;
        }
        Main.wm.allowKeybinding(Meta.external_binding_name_for_action(this._accelerator), Shell.ActionMode.ALL);
        this._acceleratorSignal = global.display.connect('accelerator-activated', (_display, action) => {
            if (action !== this._accelerator || this._grab) return;
            this._actor = new St.Widget({reactive: true, opacity: 0, width: 1, height: 1});
            Main.uiGroup.add_child(this._actor);
            this._grab = Main.pushModal(this._actor, {actionMode: Shell.ActionMode.ALL});
            this._stageSignal = global.stage.connect('captured-event', (_stage, event) => {
                if (event.type() === Clutter.EventType.KEY_RELEASE &&
                    [symbol, Clutter[`KEY_${modifier}_L`], Clutter[`KEY_${modifier}_R`]].includes(event.get_key_symbol())) {
                    this._object.emit_signal('Hotkey', new GLib.Variant('(s)', ['up']));
                    this._releaseShortcut();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            this._object.emit_signal('Hotkey', new GLib.Variant('(s)', ['down']));
        });
        this._ownerWatch = Gio.bus_watch_name_on_connection(Gio.DBus.session, invocation.get_sender(),
            Gio.BusNameWatcherFlags.NONE, null, () => this._stopShortcut());
        invocation.return_value(new GLib.Variant('(b)', [true]));
    }
    Focus() {
        const window = global.display.focus_window;
        if (!window) return 'null';
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const rect = window.get_frame_rect();
        return JSON.stringify({
            id: window.get_stable_sequence(),
            token: `gnome:${window.get_stable_sequence()}`,
            title: window.get_title() || '',
            owner: {name: app?.get_name() || window.get_wm_class() || '', processId: window.get_pid()},
            bounds: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
        });
    }
    async CaptureAsync([id], invocation) {
        const window = global.display.focus_window;
        if (!window || window.get_stable_sequence() !== id) {
            invocation.return_value(new GLib.Variant('(s)', ['null']));
            return;
        }
        const stream = Gio.MemoryOutputStream.new_resizable();
        try {
            await new Shell.Screenshot().screenshot_window(true, false, stream);
            stream.close(null);
            // Focus can change while the compositor completes the screenshot.
            if (global.display.focus_window !== window) {
                invocation.return_value(new GLib.Variant('(s)', ['null']));
                return;
            }
            const bytes = stream.steal_as_bytes();
            invocation.return_value(new GLib.Variant('(s)', [JSON.stringify({png: GLib.base64_encode(bytes.get_data())})]));
        } catch (error) {
            invocation.return_dbus_error('co.getoffgridai.Capture.Failed', String(error));
        }
    }
    PasteAsync([id, send], invocation) {
        if (!this.Activate(id)) {
            invocation.return_value(new GLib.Variant('(b)', [false]));
            return;
        }
        const backend = Clutter.get_default_backend?.() ?? global.stage.context.get_backend();
        const keyboard = backend.get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const key = (symbol, pressed) => keyboard.notify_keyval(GLib.get_monotonic_time(), symbol,
            pressed ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            if (global.display.focus_window?.get_stable_sequence() !== id) {
                invocation.return_value(new GLib.Variant('(b)', [false]));
                return GLib.SOURCE_REMOVE;
            }
            key(Clutter.KEY_Control_L, true);
            key(Clutter.KEY_v, true);
            key(Clutter.KEY_v, false);
            key(Clutter.KEY_Control_L, false);
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
                if (send && global.display.focus_window?.get_stable_sequence() === id) {
                    key(Clutter.KEY_Return, true);
                    key(Clutter.KEY_Return, false);
                }
                invocation.return_value(new GLib.Variant('(b)', [true]));
                return GLib.SOURCE_REMOVE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }
    Activate(id) {
        const window = global.get_window_actors().map(actor => actor.meta_window)
            .find(candidate => candidate.get_stable_sequence() === id);
        if (!window) return false;
        window.activate(global.get_current_time());
        return global.display.focus_window === window;
    }
}
