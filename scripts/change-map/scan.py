#!/usr/bin/env python3
"""Off Grid change map: where each concept lives, the order to change it, the checks and what collides.

Usage (from desktop/):
  python3 scripts/change-map/scan.py --list              every concept and how many places it lives
  python3 scripts/change-map/scan.py --plan writing      the change plan for one concept, as text
  python3 scripts/change-map/scan.py --html out.html     the interactive page
  python3 scripts/change-map/scan.py --json out.json     the raw map

It reads every git-tracked file in the sibling repos of the off-grid-ai workspace (shared, desktop, desktop/pro,
mobile, mobile/pro, browser-extension, website). A file joins a layer by its folder and a concept by its path name.
Concepts come from shared/packages/features (the feature list), plus model library and Pro licensing.
"""
import argparse, csv, json, re, subprocess, sys, os
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = str(HERE.parents[2])
REPOS = ['shared', 'desktop', 'desktop/pro', 'mobile', 'mobile/pro', 'browser-extension', 'website', 'executorch-speech']

CONCEPTS = {
  # key: (name, kind, regex on normalised path)
  'text':      ('Text models', 'feature', r'(llm|llama|(^|[/-])chat|generation-(service|session|tool|helpers|remote)|inference|completion|model-server|compaction|local-api|api-server|gguf|thread)'),
  'vision':    ('Vision', 'feature', r'(vision|vlm|mmproj|multimodal|image-understanding)'),
  'image':     ('Image generation', 'feature', r'(image-?gen|imagegen|image-generat|image-model|diffusion|(^|[/-])sd-|qnn|coreml-model)'),
  'video':     ('Video generation', 'feature', r'(video)'),
  'stt':       ('Speech to text', 'feature', r'(transcri|whisper|(^|[/-])stt|parakeet|speech-to-text|asr)'),
  'tts':       ('Text to speech', 'feature', r'((^|[/-])tts|kokoro|orpheus|text-to-speech|read-aloud|voice-reply|streaming-speech|playback)'),
  'dictation': ('Dictation', 'feature', r'(dictat|push-to-talk|(^|[/-])ptt)'),
  'writing':   ('Writing (Scribe)', 'feature', r'(scribe|writing|grammar|spell|rewrite|proofread)'),
  'notes':     ('Notes', 'feature', r'((^|[/-])notes?([/-]|\.|$)|obsidian|wikilink|backlink)'),
  'documents': ('Documents', 'feature', r'((^|[/-])rag([/-]|\.|$)|document|knowledge|pdf|embedding)'),
  'vault':     ('Vault', 'feature', r'(vault|password|passkey|autofill|secret)'),
  'memory':    ('Day memory', 'feature', r'(capture|screen-memory|replay|journal|clipboard|(^|[/-])focus|timeline|day-view|work-block)'),
  'meetings':  ('Meetings', 'feature', r'(meeting)'),
  'todos':     ('To-dos and people', 'feature', r'(todo|(^|[/-])crm|people|entity|briefing|identity|dossier)'),
  'agents':    ('Agents', 'feature', r'(computer-use|web-use|automation|operator|(^|[/-])agent|(^|[/-])use([/-]|$)|action-pipeline)'),
  'sync':      ('Devices and sync', 'feature', r'((^|[/-])sync|pair|mesh|transfer|discovery|companion)'),
  'models':    ('Model library', 'infra', r'(model-(download|manager|browser|catalog|residency|picks)|download|catalog|hugging-?face|huggingface|active-model|engine-pack|device-picks|best-settings|fastest-settings|recommend)'),
  'licensing': ('Pro licensing', 'infra', r'(licens|keygen|entitlement|fingerprint|paywall|purchase|revenuecat)'),
}

SKIP = re.compile(r'(^|/)(docs|outputs|\.artifacts|node_modules|dist|coverage|generated|\.github|scripts|fastlane|patches|vendor|Pods|\.vscode|test-results|marketing|demo-gifs|resources|preview-ui|tools|_includes|_layouts)(/|$)|\.(png|jpe?g|gif|webp|svg|mp4|mov|ttf|otf|woff2?|lock|ico|icns|car|mp3|wav|pdf|zip|bin|onnx|txt|md)$|package(-lock)?\.json$|tsconfig|eslint|vite|vitest|playwright|knip|jest|babel|metro')
TEST = re.compile(r'(__tests__|\.test\.|\.spec\.|(^|/)e2e/|integration-tests/|swift-tests/|(^|/)test/)')

def norm(p):
    p = re.sub(r'([a-z0-9])([A-Z])', r'\1-\2', p)
    return p.lower().replace('_', '-')

def classify(repo, p):
    """-> (surface, layer) or None"""
    if repo == 'website':
        if re.match(r'(features|guides|articles|writing|_data|index|download|pricing|pro)', p) and re.search(r'\.(md|html|ya?ml|json)$', p):
            return ('website', 'copy')
        return None
    if SKIP.search(p):
        if re.search(r'(catalog|features)[^/]*\.json$|models\.json$', p) and 'node_modules' not in p:
            pass
        else:
            return None
    if repo == 'mobile' and p.startswith('pro/'): return None
    if repo == 'desktop' and p.startswith('pro/'): return None
    surf = {'shared': 'shared', 'desktop': 'desktop', 'desktop/pro': 'desktop-pro', 'mobile': 'mobile', 'mobile/pro': 'mobile-pro',
            'browser-extension': 'extension', 'executorch-speech': 'shared'}[repo]
    if re.search(r'(catalog|features)[^/]*\.json$|models\.json$', p):
        return (surf, 'data')
    if TEST.search(p):
        return (surf, 'proof')
    if not re.search(r'\.(ts|tsx|js|mjs|cjs|swift|kt|java|m|mm|h|cpp|c|py|gd|json)$', p):
        return None
    if repo == 'shared':
        return ('shared', 'owner') if p.startswith('packages/') and '/src/' in p else None
    if repo == 'executorch-speech':
        return ('shared', 'engine') if re.match(r'(src|native)/', p) else None
    if repo == 'desktop':
        if p.startswith('packages/'): return ('desktop', 'owner')
        if p.startswith('native/') or p.startswith('electron/'): return ('desktop', 'engine')
        if p.startswith('src/renderer/'): return ('desktop', 'view')
        if p.startswith('src/'): return ('desktop', 'logic')
        return None
    if repo == 'desktop/pro':
        if p.startswith('native/'): return ('desktop-pro', 'engine')
        if p.startswith('renderer/'): return ('desktop-pro', 'view')
        if p.startswith(('main/', 'shared/')): return ('desktop-pro', 'logic')
        return None
    if repo == 'mobile':
        if p.startswith(('android/', 'ios/', 'native/')): return ('mobile', 'engine')
        if p.startswith(('src/screens/', 'src/components/', 'src/navigation/', 'src/theme/', 'src/hooks/')): return ('mobile', 'view')
        if p.startswith('src/'): return ('mobile', 'logic')
        return None
    if repo == 'mobile/pro':
        if p.startswith('native/'): return ('mobile-pro', 'engine')
        if re.search(r'(^|/)(ui|studio)/', p) or p.endswith('.tsx'): return ('mobile-pro', 'view')
        return ('mobile-pro', 'logic')
    if repo == 'browser-extension':
        if p.startswith(('src/background/', 'src/shared/')): return ('extension', 'logic')
        if p.startswith('src/'): return ('extension', 'view')
        return None

def build(root):
    cells = defaultdict(lambda: defaultdict(list))
    file_concepts = {}
    rx = {k: re.compile(v[2]) for k, v in CONCEPTS.items()}
    for repo in REPOS:
        if not os.path.isdir(os.path.join(root, repo)):
            print(f'change-map: {repo} is not checked out; skipped', file=sys.stderr)
            continue
        for p in ls(root, repo):
            c = classify(repo, p)
            if not c: continue
            hit = [k for k, r in rx.items() if r.search(norm(p))]
            full = f'{repo}/{p}'
            if hit and c[1] in ('owner', 'logic', 'view', 'engine'):
                file_concepts[full] = hit
            for k in hit:
                cells[k]['|'.join(c)].append(full)
    for surf, csvp in [('desktop', 'desktop/docs/RELEASE_TEST_CHECKLIST.csv'), ('mobile', 'mobile/docs/RELEASE_TEST_CHECKLIST.csv')]:
        try: rows = open(os.path.join(root, csvp), encoding='utf-8').read().splitlines()[1:]
        except FileNotFoundError: continue
        for row in csv.reader(rows):
            if len(row) < 3: continue
            n = norm(' '.join(row[:4])).replace(' ', '-')
            for k, r in rx.items():
                if r.search(n):
                    cells[k][f'{surf}|checklist'].append(f'#{row[0]} {row[2]}')
    pairs = defaultdict(list)
    for f, cs in file_concepts.items():
        for i, a in enumerate(cs):
            for b in cs[i+1:]:
                pairs[f'{a}|{b}'].append(f)
    try:
        feats = {x['key']: x for x in json.load(open(os.path.join(root, 'shared/packages/features/src/features.json')))}
    except FileNotFoundError:
        feats = {}
    out = {'c': {}, 'col': {k: {'n': len(v), 'files': sorted(v, key=len)[:5]} for k, v in pairs.items() if len(v) >= 2}}
    for k, (name, kind, _) in CONCEPTS.items():
        f = feats.get(k, {})
        out['c'][k] = {'name': name, 'kind': kind, 'does': f.get('does', ''), 'group': f.get('group', 'infra'),
                       'cells': {ck: {'n': len(v), 'f': (v[:12] if ck.endswith('checklist') else sorted(v, key=len)[:8]), 'all': v} for ck, v in cells[k].items()}}
    return out

SURF = [('shared', 'shared'), ('desktop', 'desktop'), ('desktop-pro', 'desktop/pro'), ('mobile', 'mobile'), ('mobile-pro', 'mobile/pro'), ('extension', 'extension'), ('website', 'website')]
APPS = ['desktop', 'mobile', 'extension', 'desktop-pro', 'mobile-pro']

def n(m, k, s, l): return m['c'][k]['cells'].get(f'{s}|{l}', {'n': 0})['n']
def builds(m, k, s): return sum(n(m, k, s, l) for l in ('owner', 'engine', 'logic', 'view'))
def places(m, k): return sum(1 for s, _ in SURF if s != 'website' and builds(m, k, s) > 0)

def plan(m, k):
    c = m['c'][k]; S = dict(SURF); lines = [f"# Change plan: {c['name']}", c['does'], '']
    def files(s, l):
        return c['cells'].get(f'{s}|{l}', {}).get('all', [])
    def gate(s):
        base = {'desktop-pro': 'desktop', 'mobile-pro': 'mobile'}.get(s, s)
        t, r = n(m, k, s, 'proof'), n(m, k, base, 'checklist')
        return f'check: {t} test files' + (f' + {r} hand-test rows' if r else '') if t or r else 'NO CHECK YET: write one first'
    step = 0
    def add(title, chk, fl):
        nonlocal step; step += 1
        lines.append(f'{step}. {title}  [{chk}]')
        lines.extend(f'     {f}' for f in fl[:15])
        if len(fl) > 15: lines.append(f'     ... {len(fl) - 15} more')
    if n(m, k, 'shared', 'owner'): add(f"Change the shared rule ({n(m, k, 'shared', 'owner')} files)", f"check: {n(m, k, 'shared', 'proof')} shared test files", files('shared', 'owner'))
    eng = [f for s, _ in SURF for f in files(s, 'engine')]
    if eng: add('Update native engines', 'check: device build + hand-test rows', eng)
    for s in APPS:
        fl = files(s, 'logic') + files(s, 'view') + (files(s, 'owner') if s == 'desktop' else [])
        if fl: add(f'Adapt {S[s]} ({len(fl)} files)', gate(s), fl)
    data = [f for s, _ in SURF for f in files(s, 'data')]
    if data: add('Update catalog rows', 'check: catalog tests', data)
    if n(m, k, 'website', 'copy'): add(f"Review website copy ({n(m, k, 'website', 'copy')} pages)", 'check: page build', files('website', 'copy'))
    rows = files('desktop', 'checklist') + files('mobile', 'checklist')
    add('Hand-test on devices, then /screen-review the changed screens', f"{n(m, k, 'desktop', 'checklist')} Mac rows, {n(m, k, 'mobile', 'checklist')} phone rows" if rows else 'NO HAND-TEST ROWS: add them first', rows)
    col = sorted(((p.split('|')[1] if p.split('|')[0] == k else p.split('|')[0], v['n']) for p, v in m['col'].items() if k in p.split('|')), key=lambda x: -x[1])
    lines += ['', 'Do not change at the same time (shared files): ' + (', '.join(f"{m['c'][o]['name']} ({v})" for o, v in col) or 'none, safe to run in parallel')]
    seams = []
    writers = [s for s in APPS if n(m, k, s, 'logic') >= 3]
    if not n(m, k, 'shared', 'owner') and len(writers) >= 2: seams.append(f"No shared owner; logic lives in {len(writers)} places ({', '.join(S[s] for s in writers)}). The same change is made {len(writers)} times.")
    no_test = [S[s] for s in APPS if builds(m, k, s) and not n(m, k, s, 'proof')]
    if no_test: seams.append('No automated tests on ' + ', '.join(no_test) + '.')
    if n(m, k, 'desktop-pro', 'logic') + n(m, k, 'mobile-pro', 'logic'): seams.append('Pro imports the open app through @offgrid/core; re-run Pro checks after any open-app change.')
    if seams: lines += ['What makes this change harder:'] + [f'  - {x}' for x in seams]
    return '\n'.join(lines)

def ls(root, repo):
    out = subprocess.run(['git', '-C', os.path.join(root, repo), 'ls-files'], capture_output=True, text=True).stdout
    return [l for l in out.splitlines() if l]

def main():
    ap = argparse.ArgumentParser(description='Off Grid change map')
    ap.add_argument('--root', default=ROOT)
    ap.add_argument('--plan'); ap.add_argument('--list', action='store_true')
    ap.add_argument('--html'); ap.add_argument('--json')
    a = ap.parse_args()
    m = build(a.root)
    if a.plan:
        key = a.plan.lower()
        if key not in m['c']:
            key = next((k for k, v in m['c'].items() if a.plan.lower() in v['name'].lower()), None)
        if not key: sys.exit(f"Unknown concept {a.plan!r}. Try --list.")
        print(plan(m, key))
    if a.list or not (a.plan or a.html or a.json):
        for k in sorted(m['c'], key=lambda k: -places(m, k)):
            print(f"{k:10} {m['c'][k]['name']:20} {places(m, k)} places")
    slim = {'c': {k: {**v, 'cells': {ck: {'n': cv['n'], 'f': cv['f']} for ck, cv in v['cells'].items()}} for k, v in m['c'].items()}, 'col': m['col']}
    if a.json: json.dump(slim, open(a.json, 'w'), indent=1)
    if a.html:
        page = (HERE / 'page.html').read_text().replace('__DATA__', json.dumps(slim, separators=(',', ':')))
        Path(a.html).write_text(page)

if __name__ == '__main__':
    main()
