#!/usr/bin/env python3
"""Persistent BrowserGym process for the local Computer Use benchmark."""

import contextlib
import atexit
import json
import os
import socket
import subprocess
import sys
import time

import browsergym.miniwob  # noqa: F401 - registers the official MiniWoB tasks
import gymnasium as gym


static_server = subprocess.Popen(
    [
        sys.executable,
        "-m",
        "http.server",
        "8888",
        "--bind",
        "127.0.0.1",
        "--directory",
        os.environ.get(
            "MINIWOB_HTML_DIR", "/usr/local/share/miniwob-plusplus/miniwob/html"
        ),
    ],
    stdout=subprocess.DEVNULL,
    stderr=sys.stderr,
)
atexit.register(static_server.terminate)
while True:
    if static_server.poll() is not None:
        raise RuntimeError("The MiniWoB web server did not start.")
    try:
        with socket.create_connection(("127.0.0.1", 8888)):
            break
    except ConnectionRefusedError:
        time.sleep(0.05)


def emit(payload):
    print("OFFGRID_JSON:" + json.dumps(payload, separators=(",", ":")), flush=True)


def observation_payload(observation):
    return {
        "goal": observation.get("goal", ""),
        "url": observation.get("url", ""),
        "axtree": observation.get("axtree_object", {}),
        "elements": observation.get("extra_element_properties", {}),
        "focusedElementId": observation.get("focused_element_bid", ""),
        "lastAction": observation.get("last_action", ""),
        "lastActionError": observation.get("last_action_error", ""),
    }


environment = None

for raw_line in sys.stdin:
    try:
        command = json.loads(raw_line)
        operation = command.get("operation")
        if operation == "reset":
            if environment is not None:
                with contextlib.redirect_stdout(sys.stderr):
                    environment.close()
            task = command["task"]
            with contextlib.redirect_stdout(sys.stderr):
                environment = gym.make(f"browsergym/miniwob.{task}")
                observation, _ = environment.reset(seed=command.get("seed"))
            emit({"ok": True, "observation": observation_payload(observation)})
        elif operation == "step":
            if environment is None:
                raise RuntimeError("Reset is required before a step.")
            with contextlib.redirect_stdout(sys.stderr):
                observation, reward, terminated, truncated, _ = environment.step(
                    command["action"]
                )
            emit(
                {
                    "ok": True,
                    "observation": observation_payload(observation),
                    "reward": float(reward),
                    "done": bool(terminated or truncated),
                    "terminated": bool(terminated),
                    "truncated": bool(truncated),
                }
            )
        elif operation == "close":
            if environment is not None:
                with contextlib.redirect_stdout(sys.stderr):
                    environment.close()
            emit({"ok": True})
            break
        else:
            raise ValueError(f"Unknown operation: {operation}")
    except Exception as error:  # The runner must classify every environment failure.
        emit({"ok": False, "error": f"{type(error).__name__}: {error}"})
