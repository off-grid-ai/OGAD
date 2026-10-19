"""Score a large "teacher" model as the actor on a held-out set, with the exact request the small
actor gets (same GOAL / PLAN / PAST / screenshot / AX text). Any OpenAI-compatible endpoint:
a hosted model or a local llama-server.

  python3 teacher_eval.py --set realsite/m2w-test_website --out preds.jsonl \
      --base https://opencode.ai/zen/v1 --model deepseek-v4.1-flash-free --key-env OPENCODE_API_KEY
  python3 score.py --role actor --meta <set>/actor.meta.jsonl --pred preds.jsonl --out score.json

The teacher is not trained on our contract, so a short system prompt states the reply format.
Predictions are written in eval_role.sh's layout ({"response", "labels"}), in row order.
"""

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SYSTEM = """You are the actor in a web agent. Each turn you get the goal, the plan with the current step marked [>], past actions, a screenshot and the page's accessibility tree, where elements carry refs like [ref=e42] or [ref=f3e17].
Reply with exactly ONE action on one line and nothing else. Use a ref from the tree. Actions:
click(ref)  type(ref,"text")  select(ref,"option")  check(ref)  uncheck(ref)  press("Enter")  scroll_down()  scroll_up()  back()  wait(ms)
Pick the action that does the current [>] step."""


def load_env(path):
    p = Path(path).expanduser()
    if p.exists():
        for line in p.read_text().splitlines():
            if '=' in line and not line.startswith('#'):
                k, v = line.split('=', 1)
                os.environ.setdefault(k.strip(), v.strip())


def content_parts(text, image_path):
    before, _, after = text.partition('<image>')
    parts = [{'type': 'text', 'text': before}]
    if image_path and Path(image_path).exists():
        b64 = base64.b64encode(Path(image_path).read_bytes()).decode()
        parts.append({'type': 'image_url', 'image_url': {'url': f'data:image/jpeg;base64,{b64}'}})
    parts.append({'type': 'text', 'text': after})
    return parts


def ask(base, model, key, text, image_path, max_tokens, retries=6):
    body = {'model': model, 'temperature': 0, 'max_tokens': max_tokens,
            'messages': [{'role': 'system', 'content': SYSTEM}, {'role': 'user', 'content': content_parts(text, image_path)}]}
    headers = {'content-type': 'application/json', 'user-agent': 'ogad-teacher-eval/1.0'}
    if key:
        headers['authorization'] = f'Bearer {key}'
    for attempt in range(retries):
        req = urllib.request.Request(base.rstrip('/') + '/chat/completions', data=json.dumps(body).encode(), headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                out = json.load(r)
            msg = out['choices'][0]['message']
            text = msg.get('content') or ''
            text = re.sub(r'<think>.*?</think>', '', text, flags=re.S).replace('<think>', '').strip()
            line = next((l.strip() for l in text.splitlines() if re.match(r'^\w+\(.*\)$', l.strip())), text.strip().splitlines()[0] if text.strip() else '')
            return line, out.get('usage', {})
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                time.sleep(min(60, 2 ** attempt * 3))
                continue
            return f'error http {e.code} {e.read()[:200]!r}', {}
        except Exception as e:  # network hiccup
            if attempt < retries - 1:
                time.sleep(min(60, 2 ** attempt * 3))
                continue
            return f'error {e}', {}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--set', required=True, help='folder with actor.jsonl (+ images/)')
    ap.add_argument('--out', required=True)
    ap.add_argument('--base', required=True)
    ap.add_argument('--model', required=True)
    ap.add_argument('--key-env', default='')
    ap.add_argument('--env-file', default='~/.opencode.env')
    ap.add_argument('--workers', type=int, default=4)
    ap.add_argument('--max-tokens', type=int, default=400)
    ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args()
    load_env(a.env_file)
    key = os.environ.get(a.key_env, '') if a.key_env else ''
    root = Path(a.set)
    rows = [json.loads(l) for l in open(root / 'actor.jsonl')]
    if a.limit:
        rows = rows[:a.limit]

    def run(row):
        user = next(m['content'] for m in row['messages'] if m['role'] == 'user')
        label = next(m['content'] for m in row['messages'] if m['role'] == 'assistant')
        img = (row.get('images') or [None])[0]
        if img and not Path(img).exists():
            img = str(root / 'images' / Path(img).name)
        started = time.time()
        reply, usage = ask(a.base, a.model, key, user, img, a.max_tokens)
        return {'response': reply, 'labels': label, 'seconds': round(time.time() - started, 2), 'usage': usage}

    with ThreadPoolExecutor(a.workers) as pool:
        preds = list(pool.map(run, rows))
    with open(a.out, 'w') as f:
        for p in preds:
            f.write(json.dumps(p) + '\n')
    errors = sum(p['response'].startswith('error') for p in preds)
    secs = sorted(p['seconds'] for p in preds)
    print(json.dumps({'rows': len(preds), 'errors': errors, 'median_s': secs[len(secs) // 2] if secs else None}), file=sys.stderr)


if __name__ == '__main__':
    main()
