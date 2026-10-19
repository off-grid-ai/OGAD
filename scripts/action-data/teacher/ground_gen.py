"""Grounding data from saved screens: the teacher writes many (goal, step, action) labels per screen
we already captured, with no browser. Each label is checked against the screen's own AX text.

  python3 ground_gen.py --runs <run_dir> [...] --out <run_dir_out> --base http://127.0.0.1:8095/v1 \
      --model qwen38 --screens 4000 --per-screen 12 --workers 64

Input rows: actor-w*.jsonl in OGAD format ({request, image, ...}); one screen per distinct image.
Output: a run dir build_dataset.py reads (actor-w0.jsonl + episodes-w0.jsonl), family "ground".
Checks: the ref exists on the screen; the verb fits the element's role (type -> textbox/searchbox/
combobox, select -> combobox/listbox, check -> checkbox/radio/switch); duplicates dropped.
"""
import argparse, glob, json, os, random, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

REF = re.compile(r"^\s*- '?(\w+)(?: \"((?:[^\"\\]|\\.)*)\")?.*?\[ref=((?:f\d+)?e\d+)\]")
ACT = re.compile(r'^(click|type|select|check|uncheck)\(((?:f\d+)?e\d+)(?:,("(?:[^"\\]|\\.)*"))?\)$')
TYPE_ROLES = {'textbox', 'searchbox', 'combobox', 'spinbutton'}
SELECT_ROLES = {'combobox', 'listbox'}
CHECK_ROLES = {'checkbox', 'radio', 'switch', 'menuitemcheckbox'}

PROMPT = """Below is one screen of a web page (screenshot + accessibility tree with refs like [ref=e42]).
Write {n} DIFFERENT things a user might want to do on THIS screen, each needing exactly ONE action now.
Mix kinds: open links/items, press buttons, fill text boxes, pick options, tick boxes, open menus, navigate sections.
Prefer realistic goals for this site. Use only refs that appear in the tree.
Reply with JSON lines only, one per item:
{{"goal": "<the user's overall goal, a full sentence>", "step": "<short plan step naming the element, e.g. Type earbuds in Search>", "action": "<one of: click(ref) | type(ref,\\"text\\") | select(ref,\\"option\\") | check(ref)>"}}
"""


def screens(runs, limit, rng, skip):
    seen, out = set(), []
    files = [f for r in runs for f in glob.glob(os.path.join(r, 'actor-w*.jsonl'))]
    rng.shuffle(files)
    for f in files:
        run = os.path.dirname(f)
        if any(s in run for s in skip):
            continue
        for line in open(f):
            try:
                r = json.loads(line)
            except Exception:
                continue
            img = r.get('image')
            if not img or '\nAX:\n' not in r.get('request', ''):
                continue
            key = (run, img)
            if key in seen:
                continue
            seen.add(key)
            out.append((run, r))
    rng.shuffle(out)
    return out[:limit]


def ask(base, model, text, image_path, tries=4):
    import base64
    parts = [{'type': 'text', 'text': text}]
    if image_path and os.path.exists(image_path):
        b64 = base64.b64encode(open(image_path, 'rb').read()).decode()
        parts.insert(0, {'type': 'image_url', 'image_url': {'url': f'data:image/jpeg;base64,{b64}'}})
    body = json.dumps({'model': model, 'temperature': 0.7, 'max_tokens': 2000, 'messages': [{'role': 'user', 'content': parts}],
                       'chat_template_kwargs': {'enable_thinking': False}}).encode()
    for i in range(tries):
        try:
            req = urllib.request.Request(base.rstrip('/') + '/chat/completions', data=body, headers={'content-type': 'application/json'})
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)['choices'][0]['message']['content'] or ''
        except Exception:
            time.sleep(2 + 3 * i)
    return ''


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs', nargs='+', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--base', default='http://127.0.0.1:8095/v1')
    ap.add_argument('--model', default='qwen38')
    ap.add_argument('--screens', type=int, default=4000)
    ap.add_argument('--per-screen', type=int, default=12)
    ap.add_argument('--workers', type=int, default=64)
    ap.add_argument('--skip', default='clones-test,m2w,frozen,teacher-test')
    ap.add_argument('--seed', type=int, default=11)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    os.makedirs(a.out, exist_ok=True)
    todo = screens(a.runs, a.screens, rng, a.skip.split(','))
    print(json.dumps({'screens': len(todo)}), flush=True)
    actor_f = open(os.path.join(a.out, 'actor-w0.jsonl'), 'a')
    ep_f = open(os.path.join(a.out, 'episodes-w0.jsonl'), 'a')
    stats = {'screens': 0, 'kept': 0, 'bad_ref': 0, 'bad_verb': 0, 'unparsed': 0}

    def work(item):
        try:
            return work_one(item)
        except Exception:
            return []

    def work_one(item):
        run, r = item
        req = r['request']
        head, ax = req.split('\nAX:\n', 1)
        roles = {m.group(3): (m.group(1), m.group(2) or '') for m in map(REF.match, ax.split('\n')) if m}
        if not roles:
            return []
        img = os.path.join(run, r['image'])
        reply = ask(a.base, a.model, PROMPT.format(n=a.per_screen) + '\nAX:\n' + ax, img)
        rows, seen = [], set()
        for line in reply.splitlines():
            line = line.strip().strip(',')
            if not line.startswith('{'):
                continue
            try:
                j = json.loads(line)
                goal, step, action = j['goal'].strip(), j['step'].strip(), j['action'].strip()
            except Exception:
                stats['unparsed'] += 1
                continue
            # Normalise the teacher's spelling: click(ref=e1) / click("e1") / spaces -> click(e1).
            action = re.sub(r'ref\s*=\s*', '', action)
            action = re.sub(r'\(\s*"((?:f\d+)?e\d+)"', r'(\1', action)
            action = re.sub(r',\s+', ',', action).replace('( ', '(').replace(' )', ')')
            m = ACT.match(action)
            if not m:
                stats['unparsed'] += 1
                continue
            verb, ref = m.group(1), m.group(2)
            if ref not in roles:
                stats['bad_ref'] += 1
                continue
            role = roles[ref][0]
            if (verb == 'type' and role not in TYPE_ROLES) or (verb == 'select' and role not in SELECT_ROLES) or (verb in ('check', 'uncheck') and role not in CHECK_ROLES):
                stats['bad_verb'] += 1
                continue
            # Canonical OGAD form: verb(ref) or verb(ref,"text") with JSON escapes.
            try:
                action = f'{verb}({ref})' if not m.group(3) else f'{verb}({ref},{json.dumps(json.loads(m.group(3)))})'
            except ValueError:
                stats['unparsed'] += 1
                continue
            if (ref, verb) in seen:
                continue
            seen.add((ref, verb))
            # Same screen and AX text; new goal and a one-step plan naming the element.
            request = f'GOAL: {goal}\nPLAN:\n[>] 1 {step}\nPAST:\n(none)\n<image>\nAX:\n{ax}'
            rows.append({'request': request, 'image': os.path.abspath(img), 'response': action, 'accepted': [action]})
        return rows

    n = 0
    with ThreadPoolExecutor(a.workers) as pool:
        for rows in pool.map(work, todo):
            stats['screens'] += 1
            for row in rows:
                n += 1
                seed = f'ground:{n}'
                row.update(id=f'{seed}:a0', seed=seed, family='ground')
                actor_f.write(json.dumps(row) + '\n')
                ep_f.write(json.dumps({'seed': seed, 'family': 'ground', 'completed': True}) + '\n')
                stats['kept'] += 1
            if stats['screens'] % 100 == 0:
                actor_f.flush(); ep_f.flush()
                print(json.dumps(stats), flush=True)
    actor_f.close(); ep_f.close()
    json.dump(stats, open(os.path.join(a.out, 'summary-w0.json'), 'w'))
    print(json.dumps(stats), flush=True)


if __name__ == '__main__':
    main()
