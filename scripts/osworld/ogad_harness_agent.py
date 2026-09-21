"""OSWorld agent adapter for the real OGAD Computer Use harness.

The OSWorld process owns the Ubuntu desktop. The TypeScript bridge owns the
OGAD control loop and fixed local models. This file only translates OSWorld's
accessibility observation into the harness contract and returns pyautogui code.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
import subprocess
import threading
from typing import Any
import xml.etree.ElementTree as ET

from mm_agents.accessibility_tree_wrap.heuristic_retrieve import filter_nodes


STATE_NS = "https://accessibility.ubuntu.example.org/ns/state"
COMPONENT_NS = "https://accessibility.ubuntu.example.org/ns/component"
VALUE_NS = "https://accessibility.ubuntu.example.org/ns/value"
RESPONSE_PREFIX = "OFFGRID_OSWORLD_JSON:"
ACTION_ROLES = {
    "button",
    "check-box",
    "combo-box",
    "entry",
    "link",
    "list-item",
    "menu-item",
    "radio-button",
    "scroll-bar",
    "searchbox",
    "slider",
    "tab",
    "tabelement",
    "text-area",
    "textarea",
    "text-field",
    "textfield",
    "textbox",
    "toggle-button",
    "tree-item",
}
EDITABLE_ROLES = {
    "combo-box",
    "entry",
    "searchbox",
    "text-area",
    "textarea",
    "text-field",
    "textfield",
    "textbox",
}


def _attribute(namespace: str, name: str) -> str:
    return f"{{{namespace}}}{name}"


def _pair(value: str | None) -> tuple[int, int] | None:
    if not value:
        return None
    try:
        parts = [int(item.strip()) for item in value.strip("()[] ").split(",")]
    except ValueError:
        return None
    return (parts[0], parts[1]) if len(parts) == 2 else None


def _state(node: ET.Element, name: str, default: bool = False) -> bool:
    value = node.get(_attribute(STATE_NS, name))
    if value is None:
        return default
    return value.lower() == "true"


def _role_name(tag: str) -> str:
    role = tag.rsplit("}", 1)[-1].lower()
    if role in EDITABLE_ROLES:
        return "AXTextField"
    words = "".join(part.capitalize() for part in role.replace("_", "-").split("-"))
    return f"AX{words or 'Unknown'}"


def snapshot_from_osworld(accessibility_tree: str) -> dict[str, Any]:
    root = ET.fromstring(accessibility_tree)
    elements: list[dict[str, Any]] = []
    for node in filter_nodes(root, platform="ubuntu"):
        role = node.tag.rsplit("}", 1)[-1].lower()
        point = _pair(node.get(_attribute(COMPONENT_NS, "screencoord")))
        size = _pair(node.get(_attribute(COMPONENT_NS, "size")))
        if point is None or size is None or size[0] <= 0 or size[1] <= 0:
            continue
        x, y = point
        width, height = size
        name = (node.get("name") or "").strip()
        text = (node.text or "").strip()
        value = (node.get(_attribute(VALUE_NS, "value")) or "").strip()
        label = name or text or value
        index = len(elements) + 1
        executable = role in ACTION_ROLES or role.endswith(("button", "item", "link"))
        elements.append(
            {
                "index": index,
                "role": _role_name(role),
                "name": label,
                "value": value,
                "cx": round(x + width / 2),
                "cy": round(y + height / 2),
                "x": x,
                "y": y,
                "width": width,
                "height": height,
                "stableId": f"ubuntu:{role}:{label}:{x}:{y}:{width}:{height}",
                "source": "ax",
                "processId": 1,
                "windowId": "osworld",
                "revision": 1,
                "checked": _state(node, "checked"),
                "selected": _state(node, "selected"),
                "focused": _state(node, "focused"),
                "executable": executable,
                "actionable": executable and role not in EDITABLE_ROLES,
                "enabled": _state(node, "enabled", True) or _state(node, "editable"),
            }
        )
    return {
        "windowTitle": "OSWorld Ubuntu desktop",
        "elements": elements,
        "processId": 1,
        "processName": "OSWorld",
        "windowId": "osworld",
        "windowBounds": {"x": 0, "y": 0, "width": 1920, "height": 1080},
        "revision": 1,
    }


class OGADHarnessAgent:
    """Use fixed models to measure the OGAD harness on OSWorld tasks."""

    action_space = "pyautogui"
    observation_type = "a11y_tree"

    def __init__(self, desktop_root: str | os.PathLike[str] | None = None):
        self.desktop_root = Path(
            desktop_root
            or os.environ.get("OFFGRID_DESKTOP_ROOT")
            or Path(__file__).resolve().parents[2]
        ).resolve()
        bridge = self.desktop_root / "scripts/osworld/ogad-harness-server.ts"
        self.logger = logging.getLogger("desktopenv.agent")
        self.process = subprocess.Popen(
            ["npx", "--yes", "tsx", str(bridge)],
            cwd=self.desktop_root,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=os.environ.copy(),
        )
        threading.Thread(target=self._copy_stderr, daemon=True).start()
        ready = self._read_response()
        if not ready.get("ok") or ready.get("event") != "ready":
            raise RuntimeError(f"OGAD harness did not start: {ready}")
        self._goal: str | None = None

    def _copy_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            self.logger.info("[ogad-harness] %s", line.rstrip())

    def _read_response(self) -> dict[str, Any]:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            if line.startswith(RESPONSE_PREFIX):
                return json.loads(line[len(RESPONSE_PREFIX) :])
        raise RuntimeError(f"OGAD harness stopped with code {self.process.poll()}")

    def _request(self, payload: dict[str, Any]) -> dict[str, Any]:
        if self.process.poll() is not None:
            raise RuntimeError(f"OGAD harness stopped with code {self.process.returncode}")
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(payload, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        response = self._read_response()
        if not response.get("ok") and response.get("action") != "FAIL":
            raise RuntimeError(response.get("error") or "OGAD harness request failed")
        return response

    def reset(self, _logger: logging.Logger | None = None) -> None:
        if _logger is not None:
            self.logger = _logger
        self._goal = None

    def predict(self, instruction: str, obs: dict[str, Any]):
        if self._goal != instruction:
            self._request({"operation": "reset", "goal": instruction})
            self._goal = instruction
        accessibility_tree = obs.get("accessibility_tree")
        if not isinstance(accessibility_tree, str) or not accessibility_tree.strip():
            return {"error": "OSWorld returned no accessibility tree"}, ["FAIL"]
        response = self._request(
            {
                "operation": "observe",
                "snapshot": snapshot_from_osworld(accessibility_tree),
            }
        )
        action = response.get("action") or "FAIL"
        info = {
            "harness": "OGAD runElementTask",
            "event": response.get("event"),
            "summary": response.get("summary"),
            "trace": response.get("trace"),
            "error": response.get("error"),
        }
        return info, [action]

    def close(self) -> None:
        if self.process.poll() is not None:
            return
        try:
            self._request({"operation": "close"})
        finally:
            self.process.terminate()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass
