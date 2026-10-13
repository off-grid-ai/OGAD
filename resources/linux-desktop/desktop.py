#!/usr/bin/env python3
"""Native Wayland focus, window capture and activation. No saved desktop state."""
import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def run(*args):
    return subprocess.check_output(args, timeout=8, text=True).strip()


def gnome(method, argument=None):
    from gi.repository import Gio, GLib
    params = GLib.Variant('(ub)', argument) if method == 'Paste' else GLib.Variant('(u)', (argument,)) if argument is not None else None
    reply = Gio.bus_get_sync(Gio.BusType.SESSION, None).call_sync(
        'org.gnome.Shell', '/co/getoffgridai/Capture', 'co.getoffgridai.Capture',
        method, params, None, Gio.DBusCallFlags.NONE, 8000, None)
    value = reply.unpack()[0]
    return json.loads(value) if isinstance(value, str) else value


def kde_id(token):
    return int.from_bytes(hashlib.sha256(token.encode()).digest()[:4], 'big')


def focus():
    desktop = os.environ.get('XDG_CURRENT_DESKTOP', '').lower()
    if os.environ.get('HYPRLAND_INSTANCE_SIGNATURE'):
        window = json.loads(run('hyprctl', 'activewindow', '-j'))
        if not window.get('address') or window.get('address') == '0x0':
            return None
        x, y = window['at']
        width, height = window['size']
        return dict(id=int(window['address'], 16), token='hyprland:' + window['address'],
                    title=window.get('title', ''), owner=dict(name=window.get('class', ''), processId=window.get('pid', 0)),
                    bounds=dict(x=x, y=y, width=width, height=height))
    if os.environ.get('SWAYSOCK'):
        def focused(node):
            if node.get('focused') and node.get('type') == 'con':
                return node
            for child in node.get('nodes', []) + node.get('floating_nodes', []):
                result = focused(child)
                if result:
                    return result
            return None
        window = focused(json.loads(run('swaymsg', '-t', 'get_tree', '-r')))
        if not window:
            return None
        return dict(id=window['id'], token='sway:' + str(window['id']), title=window.get('name') or '',
                    owner=dict(name=window.get('app_id') or (window.get('window_properties') or {}).get('class', ''), processId=window.get('pid', 0)),
                    bounds=window['rect'])
    if 'kde' in desktop:
        token = run('kdotool', 'getactivewindow')
        # Query the exact ID, then verify focus again. Names can contain newlines.
        title = run('kdotool', 'getwindowname', token)
        app = run('kdotool', 'getwindowclassname', token)
        geometry = run('kdotool', 'getwindowgeometry', token)
        import re
        position = re.search(r'Position:\s*(-?\d+),(-?\d+)', geometry)
        size = re.search(r'Geometry:\s*(\d+)x(\d+)', geometry)
        if not position or not size or run('kdotool', 'getactivewindow') != token:
            return None
        return dict(id=kde_id(token), token='kde:' + token, title=title, owner=dict(name=app, processId=0),
                    bounds=dict(x=int(position[1]), y=int(position[2]), width=int(size[1]), height=int(size[2])))
    return gnome('Focus')


def capture(expected):
    window = focus()
    if not window or window['id'] != expected:
        return None
    if window['token'].startswith('gnome:'):
        return gnome('Capture', expected)
    with tempfile.TemporaryDirectory(prefix='offgrid-window-') as directory:
        output = str(Path(directory) / 'window.png')
        if window['token'].startswith('kde:'):
            run('spectacle', '--activewindow', '--background', '--nonotify', '--output', output)
        else:
            bounds = window['bounds']
            run('grim', '-g', f"{bounds['x']},{bounds['y']} {bounds['width']}x{bounds['height']}", output)
        after = focus()
        if not after or after['id'] != expected or after['bounds'] != window['bounds']:
            return None
        return dict(png=base64.b64encode(Path(output).read_bytes()).decode('ascii'))


def activate(token):
    provider, identifier = token.split(':', 1)
    if provider == 'gnome':
        return gnome('Activate', int(identifier))
    if provider == 'sway':
        result = json.loads(run('swaymsg', f'[con_id={int(identifier)}]', 'focus'))
        if not all(item.get('success') for item in result):
            return False
    elif provider == 'hyprland':
        if not identifier.startswith('0x'):
            return False
        int(identifier, 16)
        run('hyprctl', 'dispatch', 'focuswindow', 'address:' + identifier)
    elif provider == 'kde':
        run('kdotool', 'windowactivate', identifier)
    else:
        return False
    window = focus()
    return bool(window and window['token'] == token)


def paste_kde(token, send):
    from gi.repository import Gio, GLib
    from portal import request, DESTINATION, PATH
    import time
    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    interface = 'org.freedesktop.portal.RemoteDesktop'
    session = request(bus, interface, 'CreateSession', '(a{sv})', [{'session_handle_token': GLib.Variant('s', f'offgrid_paste_{os.getpid()}')}])['session_handle']
    try:
        request(bus, interface, 'SelectDevices', '(oa{sv})', [session, {'types': GLib.Variant('u', 1)}])
        response = request(bus, interface, 'Start', '(osa{sv})', [session, '', {}])
        if not response.get('devices', 0) & 1 or not activate(token):
            return False
        time.sleep(0.15)
        def key(symbol, state):
            bus.call_sync(DESTINATION, PATH, interface, 'NotifyKeyboardKeysym',
                          GLib.Variant('(oa{sv}iu)', (session, {}, symbol, state)), None,
                          Gio.DBusCallFlags.NONE, 2000, None)
        key(0xffe3, 1)
        key(0x76, 1)
        key(0x76, 0)
        key(0xffe3, 0)
        if send:
            time.sleep(0.1)
            current = focus()
            if current and current['token'] == token:
                key(0xff0d, 1)
                key(0xff0d, 0)
        return True
    finally:
        bus.call_sync(DESTINATION, session, 'org.freedesktop.portal.Session', 'Close', None,
                      None, Gio.DBusCallFlags.NONE, 2000, None)


if __name__ == '__main__':
    try:
        operation = sys.argv[1]
        if operation == 'focus':
            result = focus()
        elif operation == 'capture':
            result = capture(int(sys.argv[2]))
        elif operation == 'activate':
            result = activate(sys.argv[2])
        elif operation == 'paste' and sys.argv[2].startswith('gnome:'):
            result = gnome('Paste', (int(sys.argv[2].split(':')[1]), sys.argv[3] == 'true'))
        elif operation == 'paste' and sys.argv[2].startswith('kde:'):
            result = paste_kde(sys.argv[2], sys.argv[3] == 'true')
        else:
            raise ValueError('Unknown desktop operation')
        print(json.dumps(result))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
