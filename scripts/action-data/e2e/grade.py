"""Auto-grade live benchmark runs against expected answers.
  python3 grade.py --tasks tasks-v1.json --runs <out_dir> [...]
A task passes when the run ended in success and its answer contains the expected answer's key facts:
every number in the expected answer appears in the run's answer, and >= 60% of its other words do.
Live sites change (a new first result, a new price), so a second grade, "grounded", also counts an
answer that the run's final page backs: every number in it and >= 60% of its words are on that page.
Grounded is an upper bound (the page may hold the wrong item); strict is a lower bound.
"""
import argparse, glob, json, math, os, re
ap = argparse.ArgumentParser(); ap.add_argument('--tasks', required=True); ap.add_argument('--runs', nargs='+', required=True); a = ap.parse_args()
tasks = {t['id']: t for t in json.load(open(a.tasks))}
norm = lambda s: re.sub(r'[^a-z0-9₹$€.%]+', ' ', str(s).lower()).strip()
nums = lambda s: set(re.findall(r'\d[\d,.]*', str(s).replace(',', '')))
res = {}
for d in a.runs:
    for f in glob.glob(os.path.join(d, '*.json')):
        if os.path.basename(f).startswith('summary'): continue
        r = json.load(open(f)); t = tasks.get(r.get('id'))
        if not t: continue
        got = (re.search(r'"(.*)"', r.get('detail') or '', re.S) or [None, ''])[1] if r.get('end') == 'success' else ''
        if t.get('app'):  # clone task: the app's own database decides
            ok = grounded = r.get('verified') is True
            res[r['id']] = {'pass': ok, 'grounded': grounded, 'group': t.get('group'), 'end': r.get('end'), 'got': got[:120], 'expected': 'verified in the app database'}
            continue
        exp = t.get('expected')  # new tasks get theirs from the frontier runs; until then only grounded counts
        en, gn = nums(exp or ''), nums(got)
        words = [w for w in norm(exp or '').split() if len(w) > 2 and not re.match(r'^\d', w)]
        wok = (sum(w in norm(got) for w in words) / len(words)) if words else 1.0
        ok = bool(exp) and bool(got) and en <= gn and wok >= 0.6
        page = norm(r.get('finalPage') or '')
        gw = [w for w in norm(got).split() if len(w) > 2]
        grounded = ok or (bool(got) and bool(page) and nums(got) <= nums(r.get('finalPage') or '') and bool(gw) and sum(w in page for w in gw) / len(gw) >= 0.6)
        res[r['id']] = {'pass': ok, 'grounded': grounded, 'group': t.get('group'), 'end': r.get('end'), 'got': got[:120], 'expected': str(exp)[:120] if exp else None, 'seconds': r.get('seconds'), 'actions': len([s for s in r.get('steps', []) if s.get('action')])}
k, n = sum(v['pass'] for v in res.values()), len(res)
p = k / n if n else 0; z = 1.96; d = 1 + z * z / n if n else 1
c = (p + z * z / (2 * n)) / d if n else 0; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d if n else 0
ends = {}
for v in res.values(): ends[v['end']] = ends.get(v['end'], 0) + 1
g = sum(v['grounded'] for v in res.values())
groups = {}
for v in res.values():
    G = groups.setdefault(v.get('group') or 'v1', [0, 0, 0]); G[0] += v['pass']; G[1] += v['grounded']; G[2] += 1
print(json.dumps({'passed': k, 'grounded': g, 'tasks': n, 'groups': {x: f'{a}/{c} (grounded {b})' for x, (a, b, c) in groups.items()}, 'rate': round(p, 3), 'ci95': [round(c - h, 3), round(c + h, 3)], 'ends': ends}))
json.dump(res, open(os.path.join(a.runs[0], 'graded.json'), 'w'), indent=1)
