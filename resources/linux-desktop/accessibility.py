#!/usr/bin/env python3
"""Read Linux desktop controls through AT-SPI for the existing Computer Use rail."""
import json
import math
import sys

import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi, Gio

MAX_NODES = 800
MAX_ELEMENTS = 120
CONTROL_ROLES = {
    'button', 'push button', 'toggle button', 'check box', 'radio button',
    'combo box', 'entry', 'password text', 'spin button', 'slider', 'menu item',
    'check menu item', 'radio menu item', 'page tab', 'list item', 'tree item',
    'table cell', 'link', 'text', 'search box', 'switch',
}


def safe(call, default=None):
    try:
        return call()
    except Exception:
        return default


def children(accessible):
    count = min(safe(accessible.get_child_count, 0) or 0, 200)
    for index in range(count):
        child = safe(lambda: accessible.get_child_at_index(index))
        if child is not None:
            yield child


def state(accessible, kind):
    states = safe(accessible.get_state_set)
    return bool(states and safe(lambda: states.contains(kind), False))


def bounds(accessible):
    component = safe(accessible.get_component_iface)
    if component is None:
        return None
    rect = safe(lambda: component.get_extents(Atspi.CoordType.SCREEN))
    if rect is None or rect.width < 3 or rect.height < 3:
        return None
    return dict(x=rect.x, y=rect.y, w=rect.width, h=rect.height)


def windows(app):
    return [window for window in children(app)
            if bounds(window) and state(window, Atspi.StateType.SHOWING)]


def running_apps():
    desktop = Atspi.get_desktop(0)
    for app in children(desktop):
        if windows(app):
            yield app


def find_app(name):
    wanted = name.casefold().strip()
    for app in running_apps():
        if (safe(app.get_name, '') or '').casefold().strip() == wanted:
            return app
    return None


def active_window(app):
    choices = windows(app)
    return next((window for window in choices
                 if state(window, Atspi.StateType.ACTIVE)), choices[0] if choices else None)


def installed_apps():
    apps = []
    for app in Gio.AppInfo.get_all():
        app_id = safe(app.get_id)
        name = safe(app.get_name)
        if app_id and name and safe(app.should_show, False):
            apps.append(dict(id=app_id, name=name))
    return apps


def element_rows(window):
    frame = bounds(window)
    stack = [(window, 0)]
    inspected = 0
    emitted = 0
    while stack and inspected < MAX_NODES and emitted < MAX_ELEMENTS:
        node, depth = stack.pop()
        inspected += 1
        role = (safe(node.get_role_name, '') or '').lower()
        rect = bounds(node)
        if rect and role in CONTROL_ROLES and state(node, Atspi.StateType.SHOWING):
            inside = (rect['x'] < frame['x'] + frame['w'] and
                      rect['y'] < frame['y'] + frame['h'] and
                      rect['x'] + rect['w'] > frame['x'] and
                      rect['y'] + rect['h'] > frame['y'])
            if inside:
                action = safe(node.get_action_iface)
                value_iface = safe(node.get_value_iface)
                value = ''
                if role in {'entry', 'text', 'search box'}:
                    text_iface = safe(node.get_text_iface)
                    if text_iface:
                        length = min(safe(text_iface.get_character_count, 0) or 0, 240)
                        value = safe(lambda: text_iface.get_text(0, length), '') or ''
                row = dict(role=role, label=safe(node.get_name, '') or '', value=value,
                           **rect, enabled=state(node, Atspi.StateType.ENABLED),
                           press=bool(action and safe(action.get_n_actions, 0)),
                           checked=state(node, Atspi.StateType.CHECKED),
                           selected=state(node, Atspi.StateType.SELECTED),
                           focused=state(node, Atspi.StateType.FOCUSED))
                if value_iface:
                    row['minValue'] = safe(value_iface.get_minimum_value)
                    row['maxValue'] = safe(value_iface.get_maximum_value)
                    row['valueSettable'] = bool(safe(value_iface.get_current_value) is not None)
                yield node, row
                emitted += 1
        if depth < 30:
            stack.extend((child, depth + 1) for child in reversed(list(children(node))))


def elements(name):
    app = find_app(name)
    window = active_window(app) if app else None
    if not window:
        return
    title = safe(window.get_name, '') or name
    rect = bounds(window)
    pid = safe(app.get_process_id, 0) or 0
    context = dict(pid=pid, process=safe(app.get_name, '') or name,
                   windowId=f'{pid}:{title}', windowX=rect['x'], windowY=rect['y'],
                   windowW=rect['w'], windowH=rect['h'])
    print('[WINDOW_TITLE] ' + title)
    print('[WINDOW_CONTEXT] ' + json.dumps(context))
    for _node, row in element_rows(window):
        print(json.dumps(row))


def activate(name):
    app = find_app(name)
    window = active_window(app) if app else None
    component = safe(window.get_component_iface) if window else None
    return bool(component and safe(component.grab_focus, False))


def launch(app_id):
    app = next((item for item in Gio.AppInfo.get_all() if safe(item.get_id) == app_id), None)
    return bool(app and safe(lambda: app.launch([], None), False))


def default_browser():
    app = Gio.AppInfo.get_default_for_uri_scheme('https')
    if not app:
        return None
    app_id = safe(app.get_id)
    name = safe(app.get_name)
    return dict(id=app_id, name=name) if app_id and name else None


def set_value(name, x, y, value):
    app = find_app(name)
    window = active_window(app) if app else None
    if not window:
        return False
    for node, row in element_rows(window):
        if (math.floor(row['x'] + row['w'] / 2 + 0.5) != x or
                math.floor(row['y'] + row['h'] / 2 + 0.5) != y):
            continue
        control = safe(node.get_value_iface)
        minimum = safe(control.get_minimum_value) if control else None
        maximum = safe(control.get_maximum_value) if control else None
        if minimum is None or maximum is None or not minimum <= value <= maximum:
            return False
        return bool(safe(lambda: control.set_current_value(value), False))
    return False


if __name__ == '__main__':
    try:
        operation = sys.argv[1]
        if operation == 'apps':
            for item in running_apps():
                print(item.get_name())
        elif operation == 'elements':
            elements(sys.argv[2])
        elif operation == 'installed':
            print(json.dumps(installed_apps()))
        elif operation == 'activate':
            print(json.dumps(activate(sys.argv[2])))
        elif operation == 'launch':
            print(json.dumps(launch(sys.argv[2])))
        elif operation == 'default-browser':
            print(json.dumps(default_browser()))
        elif operation == 'set-value':
            print(json.dumps(set_value(sys.argv[2], int(sys.argv[3]),
                                       int(sys.argv[4]), float(sys.argv[5]))))
        else:
            raise ValueError('Unknown accessibility operation.')
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
