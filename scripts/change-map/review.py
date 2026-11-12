#!/usr/bin/env python3
"""Build a change review: the screen-review pages a change already has, joined with the change map and Argus.

  python3 scripts/change-map/review.py <spec.json> <out-dir>

The spec names the change and the screen reviews it reuses (no new screenshots):
  {"title": "Scribe and Notes", "features": ["scribe", "notes"], "concepts": ["writing", "notes"],
   "reviews": [{"dir": "desktop/docs/review/scribe-notes", "surface": "desktop", "platform": "Mac"}, ...]}
Paths are relative to the off-grid-ai workspace. It writes <out-dir>/index.html, screens.json, change.json and
files.json (published path -> source file, for the Artifact publish `files` map). Argus is read from
~/.olympus/argus/sources/release.json (Build -> Next release); without it the lenses and platforms are left out.
"""
import json, os, re, subprocess, sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
sys.path.insert(0, str(HERE))
import scan  # noqa: E402  (the change map)

PLATFORMS = ['Mac', 'Windows', 'Linux', 'Android', 'iPhone', 'Chrome', 'Firefox']
REPO = {'shared': ('shared', 'Shared rules'), 'ui-library': ('ui-library', 'UI library'), 'desktop': ('OGAD', 'Desktop'),
        'desktop-pro': ('desktop-pro', 'Desktop Pro'), 'mobile': ('OGAM', 'Mobile'), 'mobile-pro': ('mobile-pro', 'Mobile Pro'),
        'extension': ('browser-extension', 'Extension')}
DIRS = {'shared': 'shared', 'desktop': 'desktop', 'desktop-pro': 'desktop/pro', 'mobile': 'mobile', 'mobile-pro': 'mobile/pro',
        'extension': 'browser-extension'}
RANK = {'GO': 0, 'INFO': 0, 'WATCH': 1, 'NO GO': 2}


def worst(vs):
    return max(vs, key=lambda v: RANK.get(v, 0)) if vs else 'GO'


def changed(surface):
    d = ROOT / DIRS[surface]
    base = subprocess.run(['git', '-C', str(d), 'merge-base', 'HEAD', 'origin/main'], capture_output=True, text=True).stdout.strip()
    if not base:
        return []
    out = subprocess.run(['git', '-C', str(d), 'diff', '--name-only', base, 'HEAD'], capture_output=True, text=True).stdout.split()
    return [f for f in out if re.search(r'\.(ts|tsx)$', f) and not re.search(r'test|spec|e2e', f)]


def principle_calls(concepts):
    """DRY / SSOT suspects: a file with the same name changed in two places, where an app keeps its own copy."""
    rxs = {c: re.compile(scan.CONCEPTS[c][2]) for c in concepts}
    by = defaultdict(list)
    for s in DIRS:
        for f in changed(s):
            n = scan.norm(f)
            hit = next((c for c, r in rxs.items() if r.search(n)), None)
            if hit:
                b = scan.norm(os.path.basename(f)).rsplit('.', 1)[0]
                # Names too generic to mean a copy: an entry file, or the feature's own name.
                if b not in ('index', 'types', 'constants', 'scribe', 'notes', 'writing'):
                    by[b].append((s, f, hit))
    dry, ssot = defaultdict(list), defaultdict(list)   # (surface, concept) -> [(name, files)]
    for b, hits in by.items():
        places = {s for s, _, _ in hits}
        if len(places) < 2:
            continue
        own = [h for h in hits if h[0] == 'shared']
        if own:
            for s, f, c in hits:
                if s == 'shared':
                    continue
                txt = (ROOT / DIRS[s] / f).read_text(errors='ignore')
                if '@offgrid/' in txt and txt.count('\n') < 60:
                    continue  # a thin adapter over the shared rule, not a copy
                dry[(s, c)].append((b, [f'{DIRS[s]}/{f}', f'shared/{own[0][1]}']))
        elif {'desktop-pro', 'mobile-pro'} <= places:
            ssot[('desktop-pro', hits[0][2])].append((b, [f'{DIRS[s]}/{f}' for s, f, _ in hits]))
    calls = []
    for (s, c), items in dry.items():
        names = ', '.join(sorted({b for b, _ in items}))
        calls.append({'surface': s, 'concept': c, 'kind': 'DRY', 'options': ['Use shared', 'Keep for now'],
                      'text': f'{REPO[s][1]} keeps its own {names}, beside the shared {scan.CONCEPTS[c][0]} rules. Use the shared ones?',
                      'files': sorted({x for _, fs in items for x in fs})})
    for (s, c), items in ssot.items():
        names = ', '.join(sorted({b for b, _ in items}))
        calls.append({'surface': s, 'concept': c, 'kind': 'SSOT', 'options': ['Move to shared', 'Keep for now'],
                      'text': f'{names}: written once in each Pro app, with no shared owner. Move to a shared package?',
                      'files': sorted({x for _, fs in items for x in fs})})
    return calls


def main(spec_path, out):
    spec = json.load(open(spec_path))
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    files, screens = {}, []
    for r in spec['reviews']:
        d = ROOT / r['dir']
        for s in json.load(open(d / 'screens.json')):
            s = dict(s)
            s['id'] = f"{r['surface']}-{s['id']}"
            s['platform'], s['surface'] = r['platform'], r['surface']

            def pub(p):
                if not p:
                    return p
                key = f"{r['surface']}/{p}"
                files[key] = str(d / p)
                return key
            for k in ('file', 'clip', 'before', 'beforeClip'):
                if s.get(k):
                    s[k] = pub(s[k])
            for v in s.get('versions', []):
                for k in ('file', 'clip', 'android', 'androidClip'):
                    if v.get(k):
                        v[k] = pub(v[k])
            screens.append(s)

    rel = {}
    p = Path.home() / '.olympus/argus/sources/release.json'
    if p.exists():
        rel = json.load(open(p)).get('data', {})
    feats = [f for f in rel.get('features', []) if f['key'] in spec['features']]
    epics = [e for e in rel.get('ship', {}).get('epics', []) if e['key'] in spec['features']]
    names = {'tech': 'Tech', 'design': 'Design', 'product': 'Product', 'business': 'Business', 'quality': 'Quality'}
    lenses, proven = [], []
    for k, name in names.items():
        cells = [(f['name'], c) for f in feats for c in f['cells'] if c['lens'] == k]
        v = worst([c['verdict'] for _, c in cells])
        line = '; '.join(f"{n}: {c['line']}" for n, c in cells if c['verdict'] not in ('GO', 'INFO')) or (cells[0][1]['line'] if cells else '')
        lenses.append({'name': name, 'verdict': v, 'line': line})
        if v == 'GO':
            proven.append(f'{name}: {line}')
    shown = {pl for e in epics for pl in e.get('shown', [])} | {s['platform'] for s in screens}
    platforms = [{'name': pl, 'shown': pl in shown} for pl in PLATFORMS if any(pl in e.get('shown', []) + e.get('missing', []) for e in epics) or pl in shown]
    missing = [{'name': f"{e['name']} · {pl}", 'why': 'not shot yet'} for e in epics for pl in e.get('missing', [])]

    repos = {x['dir']: x for x in rel.get('repos', [])}
    order = ['shared', 'ui-library', 'desktop', 'desktop-pro', 'mobile', 'mobile-pro', 'extension']
    dirmap = {'shared': 'shared', 'ui-library': 'ui-library', 'desktop': 'desktop', 'desktop-pro': 'desktop/pro', 'mobile': 'mobile', 'mobile-pro': 'mobile/pro', 'extension': 'browser-extension'}
    cmap = []
    for s in order:
        x = repos.get(dirmap[s])
        if not x or not x.get('files'):
            continue
        pr = x.get('pr') or {}
        ci = pr.get('ci')
        st = 'ok' if ci == 'passing' else 'watch' if ci == 'failing' else 'todo'
        cmap.append({'name': REPO[s][1], 'count': f"{x['files']} files", 'status': st,
                     'line': f"PR #{pr.get('n')} · CI {ci or 'not run'}" if pr else 'no PR'})
        if st == 'ok':
            proven.append(f"{REPO[s][1]}: CI passing on PR #{pr.get('n')}")

    m = scan.build(str(ROOT))
    col = defaultdict(int)
    for k, v in m['col'].items():
        a, b = k.split('|')
        for c in spec['concepts']:
            if c in (a, b):
                o = b if a == c else a
                if o not in spec['concepts']:
                    col[o] += v['n']
    collides = [m['c'][k]['name'] for k, _ in sorted(col.items(), key=lambda x: -x[1])[:3]]

    # Calls go on the screen they affect: principle suspects and NO GO findings, on that surface's screen.
    by_surface = defaultdict(list)
    for s in screens:
        by_surface[s['surface']].append(s)
        by_surface[{'desktop': 'desktop-pro', 'mobile': 'mobile-pro'}.get(s['surface'], s['surface'])].append(s)
    calls = principle_calls(spec['concepts'])
    for f in feats:
        for c in f['cells']:
            if c['verdict'] == 'NO GO' and c['lens'] != 'tech':
                calls.append({'surface': 'desktop', 'group': f['name'], 'kind': f"{names[c['lens']]} · NO GO", 'text': c['line'], 'options': ['Fix it', 'Keep for now']})
    # The heuristics only find suspects. Once Claude has read the code, the spec's own `calls` (with what it is,
    # what goes wrong and what to do) replace them, and `cleared` names the suspects that turned out fine.
    if spec.get('calls'):
        print('Suspects (spec calls used instead):')
        for c in calls:
            print(f"  {c['kind']}: {c['text']}")
        calls = [dict(c) for c in spec['calls']]
    proven += [f'Checked, not a copy: {x}' for x in spec.get('cleared', [])]
    group_of = {'writing': 'Scribe', 'notes': 'Notes'}
    for i, c in enumerate(calls):
        pool = by_surface.get(c['surface']) or screens
        want = c.get('group') or group_of.get(c.get('concept'))
        target = next((s for s in screens if s['id'] == c.get('screen')), None) \
            or next((s for s in pool if want and s.get('group', '').startswith(want)), pool[0])
        c['id'] = c.get('id') or f"call-{i}-{re.sub('[^a-z0-9]+', '-', (c.get('title') or c['text']).lower())[:40]}"
        target.setdefault('calls', []).append({k: c[k] for k in ('id', 'kind', 'title', 'text', 'what', 'risk', 'rec', 'recommended', 'files', 'options') if k in c})

    for s in screens:
        x = repos.get(dirmap.get(s['surface'], ''), {})
        pr = x.get('pr') or {}
        s['checks'] = f"{REPO[s['surface']][0]} · CI {pr.get('ci') or 'not run'}" + (f" · PR #{pr['n']}" if pr.get('n') else '')

    shared_files = [f for f in changed('shared') if re.search(r'packages/(writing|notes|notes-editor)/', f)]
    sx = repos.get('shared', {}).get('pr') or {}
    no_screen = [{'name': 'Shared rules · writing, notes, editor', 'state': 'proven' if sx.get('ci') == 'passing' else 'to check',
                  'status': 'ok' if sx.get('ci') == 'passing' else 'watch', 'line': f'{len(shared_files)} source files changed'}]

    change = {'title': spec['title'], 'verdict': rel.get('verdict', ''), 'lenses': lenses, 'map': cmap, 'collides': collides,
              'platforms': platforms, 'missing': missing, 'noScreen': no_screen, 'proven': proven}
    json.dump(screens, open(out / 'screens.json', 'w'), indent=1)
    json.dump(change, open(out / 'change.json', 'w'), indent=1)
    json.dump(files, open(out / 'files.json', 'w'), indent=1)
    (out / 'index.html').write_text((HERE / 'review.html').read_text().replace('<title>Change Review</title>', f"<title>{spec['title']} Review</title>"))
    print(f"{len(screens)} screens, {len(files)} files, {len(calls)} calls, {len(missing)} missing shots -> {out}")


if __name__ == '__main__':
    main(*sys.argv[1:3])
