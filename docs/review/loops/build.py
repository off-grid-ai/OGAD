# Builds the loop proposal page from findings/*.json. Run: python3 build.py
import json, glob, re, html, collections
F = []
for f in sorted(glob.glob('findings/*.json')):
    F += json.load(open(f))
THEMES = [
 ('sync-state', 'Show sync state on both devices',
  'Each device knows only its own switches. A page says "sync is on" while the other device drops the data.',
  'shared: one small "sharing state" message per paired device (each category on or off, vault open). Every page that syncs shows it in its header, on desktop and phone, with the step to fix it there.',
  r'sync|vault-open|peer-state|sharing|clipboard-sync|notes-sync|receive|copied text'),
 ('licence', 'Licence and Pro: say why, give the way back',
  'An expired, removed or missing licence drops you on the plain buy page, or a Pro wall appears only after you set things up.',
  'shared: one licence-state line ("expired on …", "removed by <device>", "needs Pro") with Renew, Pair again or Enter key. Desktop, phone and extension render it.',
  r'licen[cs]e|pro-required|pro wall|pro-by|removed|seat|lapsed|expired|upgrade|get pro|free-pair'),
 ('no-model', 'No model: say so, offer "Get a model"',
  'Chat, meetings, dictation, voice and the extension let you start, then fail with a generic error when no model is installed.',
  'One readiness line per feature ("Needs a speech model · Get a model") that opens Models on the right tab, on every product. Reuse the Day view pattern.',
  r'model|whisper|transcri'),
 ('permissions', 'Show permission and capture state where it blocks',
  'Capture off, Accessibility, microphone, Local Network and site access are only visible in Settings, or only logged.',
  'Put the existing state controls (CaptureToggle, permission rows) on the screens they block, with Allow or Open Settings.',
  r'permission|accessibility|microphone|\bmic\b|capture|local-network|local network|site-access|site access|hotkey|shortcut'),
 ('other-product', 'Link to the other product where it is needed',
  'The extension never links to the desktop app, the desktop links to the extension only from Scribe, the guide offers only a web link.',
  'One shared "Get / Open <product>" action, used wherever a feature needs the other product: extension first run, Vault, Web Use, Pro page, guide topics.',
  r'get-link|get the|download|first-run|other-device|extension-link|desktop-link|install|pair-to|guide-other'),
 ('approvals-tasks', 'Tasks and approvals finish where they started',
  'A phone cannot approve an action it started; Web Use waits for the browser without naming the blocker.',
  'Approve or reject on any paired device from the synced record; name the exact switch that blocks a task, on both sides.',
  r'approv|web-use|web use|task|gateway|remote'),
 ('errors', 'Failures say why in one line, with a next step',
  'Errors are built but never shown, raw engine text is printed, or the action does nothing and says nothing.',
  'shared: map known failure reasons to one plain line and a step. Every product renders that line where the action was taken.',
  r'error|raw|silent|hidden|dead|dropped|nowhere|refus|unreachable|fails|failed|lost|no reason'),
 ('names', 'One name per feature everywhere',
  'The same feature has different names in the guide, the nav, the Pro page and the other product.',
  'Pick one user-facing name per feature in shared and use it in every catalog, nav label, button and guide topic.',
  None),
]
def theme_of(x):
    t = ' '.join([x['id'], x['title'], x.get('feature',''), x['what']]).lower()
    if x.get('kind') == 'not-named' and not re.search(r'licen|sync', x['id']): return 'names'
    for tid, *_rest, rx in THEMES:
        if rx and re.search(rx, ' '.join([x['id'], x['title']]).lower()): return tid
    for tid, *_rest, rx in THEMES:
        if rx and re.search(rx, t): return tid
    return 'names' if x.get('kind') == 'not-named' else 'errors'
groups = collections.defaultdict(list)
for x in F: groups[theme_of(x)].append(x)
data = {'themes': [], 'total': len(F)}
for tid, title, problem, fix, _ in THEMES:
    items = groups.get(tid, [])
    prods = collections.Counter()
    for x in items:
        for p in re.split(r'[+,]', x.get('product','')): prods[p.strip()] += 1
    data['themes'].append({'id': tid, 'title': title, 'problem': problem, 'fix': fix, 'count': len(items),
      'products': dict(prods), 'effort': dict(collections.Counter(x.get('effort') for x in items)),
      'items': [{k: x.get(k) for k in ('id','product','direction','platform','screen','kind','title','what','risk','rec','files','effort')} for x in items]})
data['themes'].sort(key=lambda t: -t['count'])
tpl = open('page.tpl.html').read()
open('index.html','w').write(tpl.replace('/*DATA*/null', json.dumps(data)))
print({t['id']: t['count'] for t in data['themes']}, 'total', len(F))
