"""A scripted "model" for harness checks: speaks the planner/actor/evaluator contract
(docs/MODEL_CONTRACT.md) and drives each sandbox task along a fixed script.

It tests the harness, not a model: the real OGAD agent loop, the sandbox partition, the Vault fill,
the secret scrub and the commit gate all run as usual; only the decisions are scripted. Each
request body is logged, so the log shows exactly what a model would be sent.

python3 oracle.py <port> <log-file>      (OpenAI-compatible; the role is the request's "model")
"""
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT, LOG = int(sys.argv[1]), sys.argv[2]

# goal keyword -> (script, success regex). A step: (role regex, name regex, action, text, after regex)
SCRIPTS = {
    "Priya Shah": ([
        ("link|cell|row|option", r"Can we meet this week", "click", None, None),
        ("button|link", r"(^|\W)Reply$", "click", None, None),  # Roundcube names carry an icon glyph
        ("textbox", r"(?i)message|body|editor", "type", "Hi Priya, Thursday at 3pm works. Alex", None),
        ("button|link", r"(^|\W)Send$", "click", None, None),
    ], r"(?i)message sent|successfully sent|Inbox"),
    "Lunch with Sam": ([
        ("button|link|gridcell|listitem|generic|text", r"Lunch with Sam", "click", None, None),
        ("button|menuitem", r"(?i)^(more|actions|open menu|…)$", "click", None, None),
        ("button|menuitem", r"(?i)delete$", "click", None, None),
    ], r"(?i)deleted|November|Calendar"),
    "coffee beans": ([
        ("link", r"^Orders$", "click", None, None),
        ("link", r"^LC-10482$", "click", None, None),
        ("button", r"^Buy again$", "click", None, r"Coffee Beans"),
        ("link|button", r"^Proceed to checkout$", "click", None, None),
        ("button", r"^Place order$", "click", None, None),
    ], r"Payment of \$[\d.]+ accepted\. Order LC-\d+ is placed"),
    "XYZ789": ([
        ("link", r"^My trips$", "click", None, None),
        ("link", r"^XYZ789$", "click", None, None),
        ("button", r"^Cancel booking$", "click", None, None),
    ], r"Booking XYZ789 cancelled\. Refund of \$[\d.]+"),
    "streaming subscription": ([
        ("link", r"^Subscriptions$", "click", None, None),
        ("button", r"^Cancel subscription$", "click", None, r"Streamflix"),
    ], r"Streamflix is cancelled"),
    "PF-55821": ([
        ("link", r"^Pay a parking fine$", "click", None, None),
        ("textbox", r"^Fine reference$", "type", "PF-55821", None),
        ("button", r"^Pay now$", "click", None, None),
    ], r"Your reference is SPR-\d+\. Paid \$[\d.]+"),
    "balance of my everyday account": ([], r"Balance \$[\d,]+\.\d\d"),
    "upcoming trips": ([
        ("link", r"^My trips$", "click", None, None),
    ], r"\d{1,2}:\d\d"),
    "pizza": ([
        ("textbox", r"Customer name", "type", "Alex Rivera", None),
        ("textbox", r"Telephone", "type", "555-0101", None),
        ("textbox", r"E-mail", "type", "alex@example.com", None),
        ("radio", r"^Medium$", "click", None, None),
        ("checkbox", r"^Cheese$", "click", None, None),
        ("button", r"^Submit order$", "click", None, None),
    ], r'"custname": "Alex Rivera"'),
}
SIGN_IN = re.compile(r'^[ \t]*- button "(Sign in|Log in|Login|Log In)" (?:[^\[\n]|\[(?!ref=))*\[ref=([^\]\n]+)\]', re.M)
# The harness filled the emailed code (masked like a password): submit it.
TEXTBOX = re.compile(r'textbox "([^"\n]*)"([^\n]*)')
CODE_WORD = re.compile(r"[Cc]ode|OTP")
MASKED = re.compile(r': "?••••••••')
MASKED = re.compile(r': "?••••••••')


def code_filled(ax):
    """A code box (its name says code or OTP) the harness filled: its value is masked."""
    return any(
        CODE_WORD.search(m.group(1)) and MASKED.search(m.group(2))
        for m in TEXTBOX.finditer(ax)
    )
VERIFY = re.compile(r'^[ \t]*- button "(Verify|Continue|Submit)" (?:[^\[\n]|\[(?!ref=))*\[ref=([^\]\n]+)\]', re.M)
cursor: dict[str, int] = {}


def script_for(goal):
    for key, value in SCRIPTS.items():
        if key in goal:
            return key, value
    return None, ([], r"$^")


def find(ax, role, name, after):
    start = 0
    if after:
        m = re.search(after, ax)
        if not m:
            return None
        start = m.start()
    lines = ax[start:].splitlines()
    for i, line in enumerate(lines):
        m = re.match(r'^[ \t]*- (\w+) "((?:[^"\\]|\\.)*)"(?:[^\[\n]|\[(?!ref=))*\[ref=([^\]]+)\]', line)
        if m and re.fullmatch(role, m.group(1)) and re.search(name, m.group(2)):
            return m.group(3)
        # Unnamed clickable box around a text child (Nextcloud's calendar events): click the box.
        t = re.match(r'^(\s*)- \w+: (.*)$', line)
        if t and "generic" in role and re.search(name, t.group(2)):
            for up in reversed(lines[:i]):
                u = re.match(r'^([ \t]*)- (?:[^\[\n]|\[(?!ref=))*\[ref=([^\]]+)\] \[cursor=pointer\]', up)
                if u and len(u.group(1)) < len(t.group(1)):
                    return u.group(2)
    return None


def reply(role, text):
    goal = (re.search(r"GOAL: (.*)", text) or [None, ""])[1]
    ax = text.split("AX:", 1)[1] if "AX:" in text else text
    key, (steps, done) = script_for(goal)
    if role == "planner":
        if "TASK: write the complete answer" in text:
            m = re.search(done, ax)
            return m.group(0) if m else "Done."
        return "1 Do the task | check: the confirmation is shown"
    if role == "evaluator":
        if "LAST: task started" in text:
            cursor[key] = 0
        m = re.search(done, ax)
        if cursor.get(key, 0) >= len(steps) and m:
            return f'success("{m.group(0)}")'
        return "continue(1)"
    # actor
    m = SIGN_IN.search(ax)
    if m and re.search(r'textbox "[^"]*[Pp]assword', ax):
        return f"click({m.group(2)})"
    v = VERIFY.search(ax)
    if v and code_filled(ax):
        return f"click({v.group(2)})"
    i = cursor.get(key, 0)
    for j in range(i, len(steps)):
        r, name, action, value, after = steps[j]
        ref = find(ax, r, name, after)
        if ref:
            cursor[key] = j + 1
            return f'type({ref},"{value}")' if action == "type" else f"{action}({ref})"
    return "scroll_down()"


class Oracle(BaseHTTPRequestHandler):
    def _json(self, obj, status=200):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._json({"status": "ok"})
        self._json({"data": [{"id": r, "object": "model"} for r in ("planner", "actor", "evaluator")]})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        role = body.get("model", "actor")
        parts = []
        for msg in body.get("messages", []):
            content = msg.get("content")
            if isinstance(content, str):
                parts.append(content)
            elif isinstance(content, list):
                parts += [c.get("text", "") for c in content if c.get("type") == "text"]
        text = "\n".join(parts)
        out = reply(role, text)
        with open(LOG, "a") as f:
            f.write(json.dumps({"role": role, "request": text, "reply": out}) + "\n")
        self._json({"id": "oracle", "object": "chat.completion", "model": role,
                    "choices": [{"index": 0, "finish_reason": "stop",
                                 "message": {"role": "assistant", "content": out}}],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}})

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("127.0.0.1", PORT), Oracle).serve_forever()
