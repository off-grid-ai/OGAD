# Builds the loop change review page: per decision, today's screen with its marks, the real after-shots,
# and how to try each one. Run from docs/review/loops/fixes: python3 review.py  ->  index.html (shots inlined).
import base64, io, json, pathlib, re
HERE = pathlib.Path(__file__).resolve().parent
LOOPS = HERE.parent
src = (LOOPS / 'decide' / 'decide.py').read_text()
ns = {}
# The decisions (titles, today's shot and its marks) are the decision page's own list: read, not copied.
exec(src[src.index('DECISIONS = ['):src.index('\nPROD = ')], ns)
DECISIONS = ns['DECISIONS']
themes = {t['id']: t for t in json.loads(re.search(r'const DATA = (\{.*?\});\nconst OPTIONS',
          (LOOPS / 'index.html').read_text(), re.S).group(1))['themes']}

try:
    from PIL import Image
except ImportError:
    Image = None

def inline(path, width=1400):
    """A shot as a data URI, scaled to at most `width` px and saved as JPEG so the page stays small."""
    p = pathlib.Path(path)
    if not p.exists():
        return None
    if Image is None:
        mime = 'image/png' if p.suffix == '.png' else 'image/jpeg'
        return f'data:{mime};base64,' + base64.b64encode(p.read_bytes()).decode()
    im = Image.open(p).convert('RGB')
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)))
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=80, optimize=True)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()

def screens(decision):
    f = HERE / decision / 'screens.json'
    rows = json.loads(f.read_text()) if f.exists() else []
    out = []
    for r in rows:
        file = r.get('file') or r.get('shot')
        out.append(dict(id=r['id'], name=r['name'], group=r.get('group', ''), what=r.get('what', ''),
                        steps=r.get('steps') or ([r['step']] if isinstance(r.get('step'), str) and ' ' in r.get('step', '') else []),
                        img=inline(HERE / decision / file) if file else None))
    # Shots dropped in the folder without a screens.json row still show, named by their file.
    listed = {r.get('file') or r.get('shot') for r in rows}
    for p in sorted((HERE / decision).glob('*')) if (HERE / decision).exists() else []:
        if p.suffix.lower() in ('.png', '.jpg', '.jpeg') and p.name not in listed:
            out.append(dict(id=p.stem, name=p.stem.replace('-', ' '), group='', what='', steps=[], img=inline(p)))
    return out

cards = []
for d in DECISIONS:
    t = themes[d['id']]
    cards.append(dict(
        id=d['id'], title=d['title'], build=d['build'], today=d['today'], count=t['count'],
        before=dict(img=inline(LOOPS / 'decide' / 'shots' / f"{d['shot']}.jpg"), label=d['product'] + ' · today',
                    marks=d['marks'], tall=d.get('tall', False)),
        phone=dict(img=inline(LOOPS / 'decide' / 'shots' / f"{d['phone']['shot']}.jpg", 700), label=d['phone']['label'],
                   marks=d['phone']['marks']) if d.get('phone') else None,
        after=screens(d['id'])))
out = HERE / 'index.html'
tpl = (HERE / 'review.tpl.html').read_text()
out.write_text(tpl.replace('/*DATA*/null', json.dumps(dict(decisions=cards))))
shot = sum(1 for c in cards for s in c['after'] if s['img'])
todo = sum(1 for c in cards for s in c['after'] if not s['img'])
print('wrote', out, f'{out.stat().st_size // 1024} KB', len(cards), 'decisions', shot, 'after-shots', todo, 'still to shoot')
