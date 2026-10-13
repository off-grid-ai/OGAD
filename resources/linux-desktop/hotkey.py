#!/usr/bin/env python3
"""Global shortcut down/up events, with the existing ANSI settings preserved."""
import ctypes
import ctypes.util
import os
import sys
import time

KEYS = {0:'a',1:'s',2:'d',3:'f',4:'h',5:'g',6:'z',7:'x',8:'c',9:'v',11:'b',12:'q',13:'w',14:'e',15:'r',16:'y',17:'t',18:'1',19:'2',20:'3',21:'4',22:'6',23:'5',24:'equal',25:'9',26:'7',27:'minus',28:'8',29:'0',30:'bracketright',31:'o',32:'u',33:'bracketleft',34:'i',35:'p',36:'Return',37:'l',38:'j',39:'apostrophe',40:'k',41:'semicolon',42:'backslash',43:'comma',44:'slash',45:'n',46:'m',47:'period',48:'Tab',49:'space',50:'grave'}
MODIFIERS = {'option': ('Alt', 'Alt_L', 'Alt_R'), 'control': ('Control', 'Control_L', 'Control_R'), 'command': ('Super', 'Super_L', 'Super_R'), 'shift': ('Shift', 'Shift_L', 'Shift_R')}
key = KEYS[int(sys.argv[1])]
modifier, left, right = MODIFIERS[sys.argv[2]]
wayland = os.environ.get('XDG_SESSION_TYPE') == 'wayland' or (os.environ.get('XDG_SESSION_TYPE') != 'x11' and os.environ.get('WAYLAND_DISPLAY'))
if wayland:
    from gi.repository import Gio, GLib
    connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    def emit(_connection, _sender, _path, _interface, _signal, parameters):
        print(parameters.unpack()[0], flush=True)
    if any(name in os.environ.get('XDG_CURRENT_DESKTOP', '').lower() for name in ['gnome', 'ubuntu']):
        connection.signal_subscribe('org.gnome.Shell', 'co.getoffgridai.Capture', 'Hotkey', '/co/getoffgridai/Capture', None, Gio.DBusSignalFlags.NONE, emit)
        connection.call_sync('org.gnome.Shell', '/co/getoffgridai/Capture', 'co.getoffgridai.Capture', 'WatchShortcut', GLib.Variant('(ss)', (key, modifier)), None, Gio.DBusCallFlags.NONE, 5000, None)
    else:
        from portal import request, DESTINATION, PATH
        interface = 'org.freedesktop.portal.GlobalShortcuts'
        session = request(connection, interface, 'CreateSession', '(a{sv})', [{'session_handle_token': GLib.Variant('s', f'offgrid_hotkey_{os.getpid()}')}])['session_handle']
        def portal_event(_connection, _sender, _path, _interface, name, parameters):
            owner, shortcut, _timestamp, _options = parameters.unpack()
            if owner == session and shortcut == 'dictation':
                print('down' if name == 'Activated' else 'up', flush=True)
        for event in ['Activated', 'Deactivated']:
            connection.signal_subscribe(DESTINATION, interface, event, PATH, None, Gio.DBusSignalFlags.NONE, portal_event)
        mods = {'Alt': 'ALT', 'Control': 'CTRL', 'Super': 'LOGO', 'Shift': 'SHIFT'}
        shortcuts = [('dictation', {'description': GLib.Variant('s', 'Off Grid AI dictation'), 'preferred_trigger': GLib.Variant('s', mods[modifier] + '+' + key)})]
        result = request(connection, interface, 'BindShortcuts', '(oa(sa{sv})sa{sv})', [session, shortcuts, '', {}])
        if not result.get('shortcuts'):
            raise RuntimeError('The desktop did not grant the dictation shortcut.')
    GLib.MainLoop().run()
else:
    library = ctypes.CDLL(ctypes.util.find_library('X11'))
    library.XOpenDisplay.argtypes = [ctypes.c_char_p]
    library.XOpenDisplay.restype = ctypes.c_void_p
    library.XStringToKeysym.argtypes = [ctypes.c_char_p]
    library.XStringToKeysym.restype = ctypes.c_ulong
    library.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    library.XKeysymToKeycode.restype = ctypes.c_ubyte
    library.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    display = library.XOpenDisplay(None)
    if not display:
        raise RuntimeError('The desktop keyboard could not be opened.')
    def code(name):
        return library.XKeysymToKeycode(display, library.XStringToKeysym(name.encode()))
    codes = [code(name) for name in [key, left, right]]
    extra_modifiers = [code(name) for other, names in MODIFIERS.items()
                       if other != sys.argv[2] for name in names[1:]]
    if not codes[0]:
        raise RuntimeError('The shortcut key is not available in this keyboard layout.')
    library.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    library.XDefaultRootWindow.restype = ctypes.c_ulong
    library.XGrabKey.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_int]
    library.XPending.argtypes = [ctypes.c_void_p]
    library.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    root = library.XDefaultRootWindow(display)
    mask = {'Alt': 8, 'Control': 4, 'Super': 64, 'Shift': 1}[modifier]
    # Ignore Caps Lock and Num Lock without replacing another application's grab.
    for locks in [0, 2, 16, 18]:
        library.XGrabKey(display, codes[0], mask | locks, root, 0, 1, 1)
    event = (ctypes.c_long * 24)()
    held = False
    keys = (ctypes.c_ubyte * 32)()
    def down(keycode):
        return bool(keycode and keys[keycode // 8] & (1 << (keycode % 8)))
    while True:
        while library.XPending(display):
            library.XNextEvent(display, event)
        library.XQueryKeymap(display, keys)
        pressed = (down(codes[0]) and (down(codes[1]) or down(codes[2]))
                   and not any(down(other) for other in extra_modifiers))
        if pressed != held:
            print('down' if pressed else 'up', flush=True)
            held = pressed
        time.sleep(0.01)
