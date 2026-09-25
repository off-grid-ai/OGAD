#!/usr/bin/env python3
"""Serve a Laya checkpoint through the decision transport used by Desktop."""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


CONTEXT_PREFIX = "Context:\n"
QUESTION_MARKER = "\nQuestion: "
OPTIONS_MARKER = "\nOptions:\n"


def parse_decision_prompt(messages: list[dict[str, Any]]) -> tuple[str, str, list[str]]:
    user_content = next(
        (
            message.get("content")
            for message in reversed(messages)
            if message.get("role") == "user" and isinstance(message.get("content"), str)
        ),
        None,
    )
    if not isinstance(user_content, str):
        raise ValueError("A text user message is required.")
    if not user_content.startswith(CONTEXT_PREFIX):
        raise ValueError("The request does not match the Desktop decision prompt.")
    question_start = user_content.find(QUESTION_MARKER, len(CONTEXT_PREFIX))
    options_start = user_content.find(
        OPTIONS_MARKER,
        question_start + len(QUESTION_MARKER),
    )
    if question_start < 0 or options_start < 0:
        raise ValueError("The request does not match the Desktop decision prompt.")
    context = user_content[len(CONTEXT_PREFIX) : question_start]
    question = user_content[question_start + len(QUESTION_MARKER) : options_start]
    options = user_content[options_start + len(OPTIONS_MARKER) :]
    indexed: list[tuple[int, str]] = []
    for line in options.splitlines():
        index, separator, text = line.partition(": ")
        if separator and index.isdigit():
            indexed.append((int(index), text))
    indexed.sort(key=lambda item: item[0])
    if not indexed or [index for index, _ in indexed] != list(range(len(indexed))):
        raise ValueError("Decision options must use contiguous zero-based indexes.")
    return context, question, [text for _, text in indexed]


class LayaService:
    def __init__(self, model_dir: Path, requested_device: str, api_dir: Path | None = None):
        sys.path.insert(0, str(api_dir or model_dir.parent))
        import torch
        from rl_agent_api import RLAgent

        self.device = self.select_device(torch, requested_device)
        self.agent = RLAgent(str(model_dir), device=self.device)
        self.lock = threading.Lock()

    @staticmethod
    def select_device(torch: Any, requested_device: str) -> str:
        if requested_device != "auto":
            return requested_device
        if torch.cuda.is_available():
            return "cuda"
        mps = getattr(torch.backends, "mps", None)
        if mps is not None and mps.is_available():
            return "mps"
        return "cpu"

    def decide(self, context: str, question: str, options: list[str]) -> dict[str, Any]:
        criteria = {f"option_{index}": option for index, option in enumerate(options)}
        with self.lock:
            result = self.agent.system_one(
                {"context": context},
                {
                    "decision": {
                        "type": "choice",
                        "instructions": question,
                        "criteria": criteria,
                    }
                },
            )
        answer = result["answers"]["decision"]
        selected = answer["choice"]
        choice = int(selected.removeprefix("option_"))
        return {
            "choice": choice,
            "probabilities": [answer["probabilities"][f"option_{index}"] for index in range(len(options))],
        }


class DecisionHandler(BaseHTTPRequestHandler):
    service: LayaService
    model_id = "laya-typed-decisions"
    model_name = "Laya Typed Decisions"

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[laya-decision] {self.address_string()} {format % args}", flush=True)

    def send_json(self, status: int, body: dict[str, Any]) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.send_json(
                200,
                {
                    "status": "ok",
                    "model": self.model_id,
                    "device": self.service.device,
                },
            )
            return
        if self.path == "/v1/models":
            self.send_json(
                200,
                {
                    "object": "list",
                    "data": [
                        {
                            "id": self.model_id,
                            "name": self.model_name,
                            "kind": "text",
                            "architecture": {
                                "input_modalities": ["text"],
                                "output_modalities": ["text"],
                            },
                        }
                    ],
                },
            )
            return
        self.send_json(404, {"error": {"message": "Not found."}})

    def do_POST(self) -> None:
        if self.path != "/v1/chat/completions":
            self.send_json(404, {"error": {"message": "Not found."}})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length))
            context, question, options = parse_decision_prompt(request.get("messages", []))
            decision = self.service.decide(context, question, options)
            content = json.dumps(decision, separators=(",", ":"))
            completion = {
                "id": f"laya-{time.time_ns()}",
                "object": "chat.completion.chunk" if request.get("stream") else "chat.completion",
                "created": int(time.time()),
                "model": self.model_id,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": content},
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ],
            }
            if request.get("stream"):
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(f"data: {json.dumps(completion)}\n\n".encode("utf-8"))
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
                return
            self.send_json(200, completion)
        except Exception as error:
            self.send_json(400, {"error": {"message": str(error)}})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--api-dir", type=Path)
    parser.add_argument("--model-id", default="laya-typed-decisions")
    parser.add_argument("--model-name", default="Laya Typed Decisions")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--device", choices=("auto", "cuda", "mps", "cpu"), default="auto")
    args = parser.parse_args()
    os.environ.setdefault("USE_TF", "0")
    DecisionHandler.model_id = args.model_id
    DecisionHandler.model_name = args.model_name
    DecisionHandler.service = LayaService(
        args.model_dir.resolve(), args.device, args.api_dir.resolve() if args.api_dir else None
    )
    server = ThreadingHTTPServer((args.host, args.port), DecisionHandler)
    print(
        f"[laya-decision] ready http://{args.host}:{args.port}/v1 device={DecisionHandler.service.device}",
        flush=True,
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
