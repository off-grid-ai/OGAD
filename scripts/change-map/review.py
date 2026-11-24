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

PLATFORMS = ['Mac', 'Windows', 'Linux', 'Android', 'iPhone', 'Chrome', 'Firefox', 'Web']
REPO = {'shared': ('shared', 'Shared rules'), 'ui-library': ('ui-library', 'UI library'), 'desktop': ('OGAD', 'Desktop'),
        'desktop-pro': ('desktop-pro', 'Desktop Pro'), 'mobile': ('OGAM', 'Mobile'), 'mobile-pro': ('mobile-pro', 'Mobile Pro'),
        'extension': ('browser-extension', 'Extension'), 'license-worker': ('license-worker', 'Checkout')}
DIRS = {'shared': 'shared', 'desktop': 'desktop', 'desktop-pro': 'desktop/pro', 'mobile': 'mobile', 'mobile-pro': 'mobile/pro',
        'extension': 'browser-extension', 'license-worker': 'license-worker'}
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


GROUP = {'writing': ('scribe', 'writing', 'in a web text box', 'editor'), 'notes': ('notes',), 'vault': ('vault',),
         'onboarding': ('onboarding', 'desktop onboarding', 'desktop after onboarding', 'mobile onboarding')}
PLAT_OF = {'desktop': ['Mac', 'Windows', 'Linux'], 'desktop-pro': ['Mac', 'Windows', 'Linux'], 'mobile': ['iPhone', 'Android'], 'mobile-pro': ['iPhone', 'Android'],
           'extension': ['Chrome', 'Firefox'], 'shared': ['Mac', 'iPhone', 'Android', 'Chrome', 'Firefox']}
LAYERS = ('owner', 'engine', 'logic', 'view', 'data', 'copy')


def graph(m, spec, screens, calls):
    """The change as a graph for the page: concepts -> every place they live -> the platforms the screens prove.

    Edge weight is the file count; collisions are concepts outside the change that share files with it; `live` is
    what the checked-out branches change right now; calls sit on the place whose code they are about."""
    keys = spec['concepts']
    surfs = [s for s, _ in scan.SURF]
    names = dict(scan.SURF) | {'extension': 'extension'}
    concepts, edges = [], []
    for k in keys:
        c = m['c'][k]
        cells = c['cells']
        def cnt(s, l): return cells.get(f'{s}|{l}', {}).get('n', 0)
        concepts.append({'key': k, 'name': c['name'].replace('Writing (Scribe)', 'Scribe'), 'does': c['does'],
                         'files': sum(cnt(s, l) for s in surfs for l in LAYERS),
                         'tests': sum(cnt(s, 'proof') for s in surfs),
                         'rows': [r for s in ('desktop', 'mobile') for r in cells.get(f'{s}|checklist', {}).get('all', [])]})
        for s in surfs:
            layers = {l: cnt(s, l) for l in LAYERS if cnt(s, l)}
            if not layers:
                continue
            files = [f for l in LAYERS for f in cells.get(f'{s}|{l}', {}).get('all', [])]
            edges.append({'c': k, 's': s, 'n': sum(layers.values()), 'layers': layers, 'tests': cnt(s, 'proof'),
                          'files': files[:80], 'more': max(0, len(files) - 80)})
    live = {}
    for s in DIRS:
        rx = [re.compile(scan.CONCEPTS[k][2]) for k in keys]
        hit = [f'{DIRS[s]}/{f}' for f in changed(s) if any(r.search(scan.norm(f)) for r in rx)]
        if hit:
            br = subprocess.run(['git', '-C', str(ROOT / DIRS[s]), 'branch', '--show-current'], capture_output=True, text=True).stdout.strip()
            live[s] = {'branch': br, 'files': hit}
    places = []
    for s in surfs:
        n = sum(e['n'] for e in edges if e['s'] == s)
        if n:
            places.append({'key': s, 'name': {'shared': 'Shared rules', 'desktop': 'Desktop', 'desktop-pro': 'Desktop Pro', 'mobile': 'Mobile',
                                              'mobile-pro': 'Mobile Pro', 'extension': 'Extension', 'website': 'Website'}[s],
                           'path': names[s], 'n': n, 'live': live.get(s)})
    # Checkout (license-worker) is no scan surface, so its place comes from what its branch changes now.
    if live.get('license-worker'):
        places.append({'key': 'license-worker', 'name': 'Checkout', 'path': DIRS['license-worker'],
                       'n': len(live['license-worker']['files']), 'live': live['license-worker']})
    plats = []
    for p in PLATFORMS:
        # An iPhone shot with an Android version proves Android too, as the coverage rows count it.
        on = [sc for sc in screens if sc['platform'] == p or
              (p == 'Android' and any(v.get('android') for v in sc.get('versions', [])))]
        if not on:
            continue
        by = {k: [sc['id'] for sc in on if str(sc.get('group', '')).lower().startswith(GROUP.get(k, (k,)))] for k in keys}
        plats.append({'name': p, 'n': len(on), 'by': by, 'first': on[0]['id']})
    pedges = [{'s': s, 'p': p} for s in surfs for p in PLAT_OF.get(s, []) if any(x['key'] == s for x in places) and any(x['name'] == p for x in plats)]
    col = []
    for pair, v in m['col'].items():
        a, b = pair.split('|')
        if a in keys and b in keys:
            col.append({'a': a, 'b': b, 'n': v['n'], 'files': v['files'], 'inside': True})
        elif a in keys or b in keys:
            ours, other = (a, b) if a in keys else (b, a)
            col.append({'a': ours, 'b': other, 'name': m['c'][other]['name'], 'n': v['n'], 'files': v['files']})
    col.sort(key=lambda x: -x['n'])
    surf_of = {'desktop': 'desktop', 'mobile': 'mobile', 'extension': 'extension', 'shared': 'shared'}
    gcalls = []
    for c in calls:
        scr = next((s for s in screens if any(x['id'] == c['id'] for x in s.get('calls', []))), None)
        gcalls.append({'id': c['id'], 'title': c.get('title') or c.get('text', ''), 'kind': c.get('kind', ''),
                       's': c.get('surface') or surf_of.get(scr['surface'] if scr else '', 'shared'), 'screen': scr['id'] if scr else None})
    return {'concepts': concepts, 'places': places, 'edges': edges, 'platforms': plats, 'pedges': pedges,
            'collides': [x for x in col if not x.get('inside')][:6], 'inside': [x for x in col if x.get('inside')], 'calls': gcalls}


def main(spec_path, out):
    spec = json.load(open(spec_path))
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    files, screens, proves = {}, [], {}
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
            # Which release features this shot proves: the review's own list, else its group.
            proves[id(s)] = set(r.get('features', [])) | {str(s.get('group', '')).lower()}

    rel = {}
    p = Path.home() / '.olympus/argus/sources/release.json'
    if p.exists():
        rel = json.load(open(p)).get('data', {})
    feats = [f for f in rel.get('features', []) if f['key'] in spec['features']]
    epics = [e for e in rel.get('ship', {}).get('epics', []) if e['key'] in spec['features']]
    shown = {pl for e in epics for pl in e.get('shown', [])} | {s['platform'] for s in screens} | \
        {'Android' for s in screens for v in s.get('versions', []) if v.get('android')}
    platforms = [{'name': pl, 'shown': pl in shown} for pl in PLATFORMS if any(pl in e.get('shown', []) + e.get('missing', []) for e in epics) or pl in shown]
    # The platforms each feature must be shot on: the spec's `require` (the release bar), else
    # what Argus lists. A feature counts as shot on a platform when this page has a shot of it there.
    require = spec.get('require', {})
    def shot_on(e):
        keys = {e['key'], e['name'].lower()}
        mine = [sc for sc in screens if proves.get(id(sc), set()) & keys]
        # An iPhone shot with an Android version proves Android for that feature too.
        return {sc['platform'] for sc in mine} | {'Android' for sc in mine for v in sc.get('versions', []) if v.get('android')}
    names = {'tech': 'Tech', 'design': 'Design', 'product': 'Product', 'business': 'Business', 'quality': 'Quality'}

    def current(f, c):
        """Argus counts only PR-screenshot folders: drop 'Never shown on X' where this page shows it."""
        line = c['line']
        m = re.search(r'Never shown on ([^.;]+)\.?\s*', line)
        if not m:
            return c['verdict'], line
        on = shot_on({'key': f['key'], 'name': f['name']})
        left = [pl.strip() for pl in m.group(1).split(',') if pl.strip() not in on]
        line = line.replace(m.group(0), f"Never shown on {', '.join(left)}. " if left else '').strip()
        return (c['verdict'] if line else 'GO'), line

    lenses, proven = [], []
    for k, name in names.items():
        cells = [(f['name'], *current(f, c)) for f in feats for c in f['cells'] if c['lens'] == k]
        v = worst([cv for _, cv, _ in cells])
        line = '; '.join(f"{n}: {cl}" for n, cv, cl in cells if cv not in ('GO', 'INFO') and cl) or (cells[0][2] if cells else '')
        lenses.append({'name': name, 'verdict': v, 'line': line})
        if v == 'GO' and line:
            proven.append(f'{name}: {line}')
    missing = [{'name': f"{e['name']} · {pl}", 'why': 'not shot yet'}
               for e in epics
               for pl in require.get(e['key'], e.get('missing', []))
               if pl not in shot_on(e)]

    repos = {x['dir']: x for x in rel.get('repos', [])}
    order = ['shared', 'ui-library', 'desktop', 'desktop-pro', 'mobile', 'mobile-pro', 'extension', 'license-worker']
    dirmap = {'shared': 'shared', 'ui-library': 'ui-library', 'desktop': 'desktop', 'desktop-pro': 'desktop/pro', 'mobile': 'mobile', 'mobile-pro': 'mobile/pro', 'extension': 'browser-extension', 'license-worker': 'license-worker'}
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
    # Every product the change belongs in must show on the page: one with no code yet, or no shots yet, gets
    # a missing row, so a gap is seen without anyone looking for it (the extension's first run was missed).
    def shots_of(k):
        """The platforms this concept's own screens are shot on: an unrelated screen proves nothing for it."""
        mine = [s for s in screens if k in proves.get(id(s), set())
                or str(s.get('group', '')).lower().startswith(GROUP.get(k, (k,)))]
        return {s['platform'] for s in mine} | {'Android' for s in mine for v in s.get('versions', []) if v.get('android')}
    for k in spec['concepts']:
        c = m['c'].get(k, {})
        shots = shots_of(k)
        for app in c.get('apps', []):
            for pl in PLAT_OF.get(app, []):
                # Windows and Linux are outside the release bar: checked only once the page has shots there.
                if pl in ('Windows', 'Linux') and not any(s['platform'] == pl for s in screens):
                    continue
                name = f"{c['name']} · {pl}"
                unbuilt = app in c.get('missing', [])
                # Shots of today's screens never close a product that has nothing built yet.
                if (pl in shots and not unbuilt) or any(x['name'] == name for x in missing):
                    continue
                missing.append({'name': name, 'why': f'not built on the {app} yet' if unbuilt else 'not shot yet'})
                if not any(x['name'] == pl for x in platforms):
                    platforms.append({'name': pl, 'shown': False})
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
    # What earlier rounds taught (learned.json, kept by the graph-engineering-loop skill): suspects already judged
    # fine never come back, and a kind of call Mac always answers the same way carries that answer as a standing rule.
    learned = json.load(open(HERE / 'learned.json')) if (HERE / 'learned.json').exists() else {}
    known_fine = [x['match'] for x in learned.get('cleared', [])]
    calls = [c for c in calls if not any(m in c['text'] for m in known_fine)]
    if spec.get('calls'):
        print('Suspects (spec calls used instead):')
        for c in calls:
            print(f"  {c['kind']}: {c['text']}")
        calls = [dict(c) for c in spec['calls']]
    for c in calls:
        rule = next((r for r in learned.get('standing', []) if c.get('kind', '').startswith(r['kind'])), None)
        if rule and rule['choice'] in c.get('options', []):
            c['recommended'] = rule['choice']
            c['standing'] = f"Standing rule: {rule['choice']}. {rule['why']}"
    proven += [f'Checked, not a copy: {x}' for x in spec.get('cleared', [])]
    group_of = {'writing': 'Scribe', 'notes': 'Notes'}
    for i, c in enumerate(calls):
        pool = by_surface.get(c['surface']) or screens
        want = c.get('group') or group_of.get(c.get('concept'))
        target = next((s for s in screens if s['id'] == c.get('screen')), None) \
            or next((s for s in pool if want and s.get('group', '').startswith(want)), pool[0])
        c['id'] = c.get('id') or f"call-{i}-{re.sub('[^a-z0-9]+', '-', (c.get('title') or c['text']).lower())[:40]}"
        target.setdefault('calls', []).append({k: c[k] for k in ('id', 'kind', 'title', 'text', 'what', 'risk', 'rec', 'recommended', 'standing', 'files', 'options') if k in c})

    for s in screens:
        x = repos.get(dirmap.get(s['surface'], ''), {})
        pr = x.get('pr') or {}
        s['checks'] = f"{REPO[s['surface']][0]} · CI {pr.get('ci') or 'not run'}" + (f" · PR #{pr['n']}" if pr.get('n') else '')

    # The shared writing/notes rules have no screen of their own: listed only for a change that touches them.
    no_screen = []
    if {'writing', 'notes'} & set(spec['concepts']):
        shared_files = [f for f in changed('shared') if re.search(r'packages/(writing|notes|notes-editor)/', f)]
        sx = repos.get('shared', {}).get('pr') or {}
        no_screen = [{'name': 'Shared rules · writing, notes, editor', 'state': 'proven' if sx.get('ci') == 'passing' else 'to check',
                      'status': 'ok' if sx.get('ci') == 'passing' else 'watch', 'line': f'{len(shared_files)} source files changed'}]

    change = {'title': spec['title'], 'verdict': rel.get('verdict', ''), 'lenses': lenses, 'map': cmap, 'collides': collides,
              'platforms': platforms, 'missing': missing, 'noScreen': no_screen, 'proven': proven,
              'graph': graph(m, spec, screens, calls)}
    json.dump(screens, open(out / 'screens.json', 'w'), indent=1)
    json.dump(change, open(out / 'change.json', 'w'), indent=1)
    json.dump(files, open(out / 'files.json', 'w'), indent=1)
    (out / 'index.html').write_text((HERE / 'review.html').read_text().replace('<title>Change Review</title>', f"<title>{spec['title']} Review</title>"))
    print(f"{len(screens)} screens, {len(files)} files, {len(calls)} calls, {len(missing)} missing shots -> {out}")


if __name__ == '__main__':
    main(*sys.argv[1:3])
