"""Flatten teacher task folders into one run dir that build_dataset.py reads, keeping only tasks
whose answer is backed by the final page (>= 60% of its words appear in the final AX text).
  python3 flatten.py <teacher_out> <run_dir> [--skip ajio] [--tasks tasks.json --split train|test] [--answers answers.json]
--tasks/--split keep only tasks of one split (never train on test tasks). --answers also requires the
teacher's answer to match the expected answer (>= 60% of its words), when one is known.
"""
import json, re, shutil, sys
from pathlib import Path

src, dst = Path(sys.argv[1]), Path(sys.argv[2])
arg = lambda k: sys.argv[sys.argv.index(k) + 1] if k in sys.argv else None
skip = arg('--skip').split(',') if arg('--skip') else []
split_ids = None
if arg('--tasks'):
    split_ids = {t['id'] for t in json.load(open(arg('--tasks'))) if t.get('split', 'train') == (arg('--split') or 'train')}
answers = {}
if arg('--answers'):
    raw = json.load(open(arg('--answers')))
    answers = {k: (v.get('answer') if isinstance(v, dict) else v) for k, v in raw.items()}
(dst / 'images').mkdir(parents=True, exist_ok=True)
norm = lambda t: re.sub(r'[^a-z0-9₹$€.%]+', ' ', t.lower()).strip()
kept = dropped = 0
out = {k: open(dst / f'{k}-w0.jsonl', 'w') for k in ('actor', 'evaluator', 'planner')}
episodes = open(dst / 'episodes-w0.jsonl', 'w')
for d in sorted(p for p in src.iterdir() if p.is_dir() and not p.name.startswith('.')):
    if any(s in d.name for s in skip) or not (d / 'episodes.jsonl').exists() or (split_ids is not None and d.name not in split_ids):
        continue
    ep = json.loads((d / 'episodes.jsonl').read_text().splitlines()[-1])
    ev = [json.loads(l) for l in open(d / 'evaluator.jsonl')] if (d / 'evaluator.jsonl').exists() else []
    end = next((r for r in ev if r['id'].endswith(':end')), None)
    ok = False
    if ep['end'] == 'success' and end and end.get('answer'):
        words = [w for w in norm(end['answer']).split() if len(w) > 2]
        page = norm(end['request'].split('\nAX:\n', 1)[-1])
        ok = bool(words) and sum(w in page for w in words) / len(words) >= 0.6
        want = answers.get(d.name)
        if ok and want:
            ww = [w for w in norm(str(want)).split() if len(w) > 2]
            got = norm(end['answer'])
            ok = not ww or sum(w in got for w in ww) / len(ww) >= 0.6
    ep['verified'] = ok
    ep.update(seed=ep['id'], family='teacher', completed=ok)
    episodes.write(json.dumps(ep) + '\n')
    if not ok:
        dropped += 1
        continue
    kept += 1
    for k in ('actor', 'evaluator', 'planner'):
        f = d / f'{k}.jsonl'
        if f.exists():
            for l in open(f):
                out[k].write(l)
    for img in (d / 'images').glob('*.jpg'):
        shutil.copy2(img, dst / 'images' / img.name)
    if (d / 'boxed.jsonl').exists():
        with open(dst / 'boxed-w0.jsonl', 'a') as b:
            b.write((d / 'boxed.jsonl').read_text())
json.dump({'kept': kept, 'dropped': dropped}, open(dst / 'summary-w0.json', 'w'))
print({'kept': kept, 'dropped': dropped})
