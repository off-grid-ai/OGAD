"""A logging pass-through in front of the role servers: proves what the models are sent.

python3 prompt-tap.py <listen-port> <target-port> <log-file>
Each request body (the full prompt OGAD sends a model) is appended to the log as one JSON line,
then forwarded unchanged. 127.0.0.1 only. Images are cut out to keep the log small.
"""
import json
import re
import sys
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LISTEN, TARGET, LOG = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]


class Tap(BaseHTTPRequestHandler):
    def _forward(self, body=None):
        req = urllib.request.Request(f"http://127.0.0.1:{TARGET}{self.path}", data=body, method=self.command)
        for k, v in self.headers.items():
            if k.lower() not in ("host", "content-length"):
                req.add_header(k, v)
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                data, status, headers = r.read(), r.status, r.headers
        except urllib.error.HTTPError as e:
            data, status, headers = e.read(), e.code, e.headers
        self.send_response(status)
        for k, v in headers.items():
            if k.lower() not in ("transfer-encoding", "connection", "content-length"):
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._forward()

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        text = re.sub(r"data:image/[^\"]+", "data:image/…", body.decode("utf-8", "replace"))
        with open(LOG, "a") as f:
            f.write(json.dumps({"port": LISTEN, "path": self.path, "body": text}) + "\n")
        self._forward(body)

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("127.0.0.1", LISTEN), Tap).serve_forever()
