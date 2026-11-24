# Builds the loop decision page: one real screen per decision, marks on the shot, the fix drawn on it.
# Run from this folder: python3 decide.py   (reads ../findings/*.json through ../build.py's grouping)
import json, re, sys, pathlib
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import os
os.chdir(HERE.parent)
src = open('index.html').read()
data = json.loads(re.search(r'const DATA = (\{.*?\});\nconst OPTIONS', src, re.S).group(1))
themes = {t['id']: t for t in data['themes']}

# Marks and the drawn fix use percent positions on the shot (x, y from the top-left).
DECISIONS = [
 dict(id='sync-state', phone=dict(shot='a-notes', label='Android · Notes · today', marks=[dict(x=50, y=56.3, n=3, text='Phone Notes says notes "stay on this device". They sync, and nothing shows the state')], after=[dict(x=5, y=40, w=90, text='Syncs with your Mac · Notes sync is off there', kind='chip')]),
  title='Sync: show what the other device has on', shot='vault', product='Desktop · Vault',
  today='The page knows only this computer\'s switch. The phone can have Vault sync off, or its vault locked, and nothing here says so.',
  hurts='You save a password here and expect it on your phone. It never arrives, and no screen tells you why.',
  build='Each device tells the other what it has on. Vault, Notes, Clipboard and Writing show the other device\'s state in the header, with the step to fix it there.',
  marks=[dict(x=86, y=6, n=1, text='The header knows only this computer\'s switch'),
         dict(x=57, y=50, n=2, text='Phone vault locked or sync off: not shown')],
  after=[dict(x=63, y=3.2, w=35, text='iPhone: Vault sync is off · turn it on there', kind='chip')]),
 dict(id='licence', phone=dict(shot='a-sync', label='Android · Sync · today', marks=[dict(x=35, y=63, n=3, text='"Needs pairing: this device no longer holds its pairing": the fault, not the step')], after=[dict(x=5, y=67.5, w=90, text='iPhone lost its pairing · Pair again', kind='chip')]),
  title='Licence: say why Pro stopped, and the way back', shot='pro', product='Desktop · Pro page',
  today='An expired or removed licence drops you here, on the plain "Pro is here" sales page, with no reason.',
  hurts='A paying customer thinks they lost what they bought, or that the app is broken.',
  build='One licence line on every product: "Your licence ended on 2 Nov", "This Mac was removed from your licence", with Renew, Pair again or Enter key.',
  marks=[dict(x=22, y=4.4, n=1, text='A lapsed customer sees the sales pitch'),
         dict(x=79, y=36, n=2, text='A wrong key gives no next step')],
  after=[dict(x=16.5, y=12.5, w=45, text='Your licence ended on 2 Nov · Renew · Enter a key', kind='banner')]),
 dict(id='no-model', phone=dict(shot='a-picker', label='Android · Chat models · today', marks=[dict(x=80.4, y=63.2, n=3, text='No chat model (the computer is offline): just a dash, no reason, no button')], after=[dict(x=5, y=54.5, w=90, text='Your Mac is offline · wake it, or Get a model', kind='chip')]),
  title='No model: say so before you start', shot='meetings', product='Desktop · Meetings',
  today='Record starts with no speech model installed. After the call it says "Transcription failed, retry".',
  hurts='You lose the meeting notes, and Retry can never work.',
  build='One readiness line per feature: "Needs a speech model · Get one". It opens Models on the right tab. Same on chat, voice, dictation, phone and extension.',
  marks=[dict(x=93.7, y=12.6, n=1, text='Starts with no speech model'),
         dict(x=84, y=28.5, n=2, text='Later: "Transcription failed, retry"')],
  after=[dict(x=72, y=17, w=26, text='Needs a speech model · Get one', kind='chip')]),
 dict(id='errors', phone=dict(shot='a-chat', label='Android · Chat · today', marks=[dict(x=20, y=25.2, n=3, text='Raw tool text reaches you: "Task reference … Do not call web_use again"')], after=[dict(x=5, y=19.5, w=90, text='Started a web task · watch it live', kind='chip')]),
  title='Failures: one plain line, with a next step', shot='integrations', product='Desktop · Integrations',
  today='Some errors are built but never shown, some print raw engine text, and some actions do nothing and say nothing.',
  hurts='People click again, give up, or think the feature is broken.',
  build='One shared list of known failures, each with one plain line and a step. Every product shows it where you clicked.',
  marks=[dict(x=51.3, y=30.2, n=1, text='Connect does nothing on the free plan'),
         dict(x=31.8, y=89, n=2, text='A broken connector gives the wrong advice')],
  after=[dict(x=34, y=23.8, w=22, text='Gmail and Calendar need Pro · See Pro', kind='chip')]),
 dict(id='permissions', phone=dict(shot='a-chat', label='Android · Chat · today', marks=[dict(x=88.1, y=95.9, n=3, text='Mic crossed out: no microphone permission, no word, no Allow')], after=[dict(x=33, y=88.5, w=54, text='Microphone is off · Allow', kind='chip')]),
  title='Permissions: show what is off, where it blocks', shot='clipboard', product='Desktop · Clipboard',
  today='With capture off, Clipboard looks like nothing was copied. Capture, microphone and Accessibility state live only in Settings.',
  hurts='You think the feature is broken. You don\'t know a switch is off.',
  build='Put the existing switch (capture, microphone, Accessibility, Local Network) on the screen it blocks, with Turn on or Open Settings.',
  marks=[dict(x=37, y=33, n=1, text='Capture off looks like "nothing copied"'),
         dict(x=92, y=13.2, n=2, text='The shortcut can fail without a word')],
  after=[dict(x=16.5, y=27.3, w=40, text='Clipboard capture is off · Turn on', kind='banner')]),
 dict(id='other-product', phone=dict(shot='a-pro2', label='Android · Pro tab · today', marks=[dict(x=32, y=70.6, n=2, text='"Desktop" sends you to the website, though your Mac is paired'), dict(x=32, y=79.3, n=3, text='"Browser extension" opens the Chrome Web Store, whatever browser you use')], after=[dict(x=5, y=83.6, w=90, text='Opens the store for your browser · or Open Desktop', kind='chip')]),
  title='Link to the other app where it is needed', shot='ext-writing', product='Extension · panel', tall=True,
  today='The extension never links to the desktop app. The desktop links to the extension only from Scribe, and only to Chrome.',
  hurts='Features that need both apps dead-end. People never find the other half.',
  build='One shared "Get / Open <app>" action, used wherever a feature needs the other app: extension first run, Vault, Web Use, Pro page, guide.',
  marks=[dict(x=50, y=45, n=1, text='No way to get or open the desktop app')],
  after=[dict(x=4, y=37, w=92, text='Works with Off Grid AI for Mac · Open it · Get it', kind='banner')]),
 dict(id='approvals-tasks', phone=dict(shot='a-mcp', label='Android · Pro tools · today', marks=[dict(x=11.9, y=54.2, n=2, text='Both computers are offline, yet green dots, switches on, "0 of 20 tools"')], after=[dict(x=44, y=50.3, w=52, text='Offline · open Desktop there', kind='chip')]),
  title='Tasks: finish on the device you started on', shot='gateway', product='Desktop · Gateway (one example)',
  today='A phone cannot approve an action it started. Web Use waits for "your browser" without naming what blocks it. Gateway never says if it runs.',
  hurts='Work stalls, and you must walk to the computer to find out why.',
  build='Approve or reject on any paired device. Name the exact switch that blocks a task, on both sides. Show "Running" on Gateway.',
  marks=[dict(x=28, y=5.7, n=1, text='Never says if it is running')],
  after=[dict(x=27.5, y=3.4, w=17, text='● Running', kind='chip')]),
 dict(id='names', phone=dict(shot='a-pro', label='Android · Pro tab · today', marks=[dict(x=72, y=51, n=2, text='"Copy here, paste there" = Clipboard; "Your chats, on every device" = Sync; "MCP tools" opens "Pro tools"')], after=[dict(x=40, y=46.3, w=55, text='One name on every app', kind='chip')]),
  title='One name per feature, everywhere', shot='notifications', product='Desktop · Notifications',
  today='The same feature has different names: "Connectors" in chat, "Integrations" in the menu. The Pro page promises approvals in Notifications; they live in Actions.',
  hurts='People look in the wrong place and decide the feature is missing.',
  build='One user-facing name per feature, kept in shared code and used by every menu, button and guide topic.',
  marks=[dict(x=57, y=59, n=1, text='Promised approvals are not here (they are in Actions)')],
  after=[dict(x=46, y=67, w=22, text='Approvals are in Actions →', kind='chip')]),
]
PROD = {'desktop': 'Desktop', 'mobile': 'Phone', 'extension': 'Extension'}
for d in DECISIONS:
    t = themes[d['id']]
    d['count'] = t['count']
    d['products'] = {PROD.get(k, k): v for k, v in t['products'].items()}
    d['small'] = t['effort'].get('S', 0)
    d['cross'] = sum(1 for i in t['items'] if i.get('kind') == 'cross-product')
    d['also'] = [dict(title=i['title'], where=i.get('direction') or i.get('product'), what=i['what'], rec=i['rec']) for i in t['items']]
out = HERE / 'index.html'
tpl = (HERE / 'page.tpl.html').read_text()
out.write_text(tpl.replace('/*DATA*/null', json.dumps({'total': data['total'], 'decisions': DECISIONS})))
print('wrote', out, len(DECISIONS), 'decisions', data['total'], 'findings')
