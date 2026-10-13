"""XDG portal request handling, shared by screen recording and keyboard input."""
import os
from gi.repository import Gio, GLib

DESTINATION = 'org.freedesktop.portal.Desktop'
PATH = '/org/freedesktop/portal/desktop'


def request(bus, interface, method, signature, arguments):
    waiter = GLib.MainLoop()
    response = []
    def receive(_connection, _sender, _path, _interface, _signal, params):
        response.append(params.unpack())
        waiter.quit()
    token = f'offgrid_{os.getpid()}_{method.lower()}'
    sender = bus.get_unique_name()[1:].replace('.', '_')
    request_path = f'{PATH}/request/{sender}/{token}'
    arguments[-1]['handle_token'] = GLib.Variant('s', token)
    subscription = bus.signal_subscribe(DESTINATION, 'org.freedesktop.portal.Request', 'Response', request_path,
                                        None, Gio.DBusSignalFlags.NONE, receive)
    timed_out = False
    def expire():
        nonlocal timed_out
        timed_out = True
        try:
            bus.call_sync(DESTINATION, request_path, 'org.freedesktop.portal.Request', 'Close', None,
                          None, Gio.DBusCallFlags.NONE, 2000, None)
        except Exception:
            pass
        waiter.quit()
        return False
    timeout = GLib.timeout_add_seconds(110, expire)
    try:
        bus.call_sync(DESTINATION, PATH, interface, method, GLib.Variant(signature, tuple(arguments)),
                      None, Gio.DBusCallFlags.NONE, 10000, None)
        if not response:
            waiter.run()
        if timed_out:
            raise RuntimeError('Desktop permission was not granted in time. Try again.')
        code, values = response[0]
        if code != 0:
            raise RuntimeError('Desktop permission was cancelled or refused.')
        return values
    finally:
        if not timed_out:
            GLib.source_remove(timeout)
        bus.signal_unsubscribe(subscription)
