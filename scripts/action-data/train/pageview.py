"""The ranked page view (contract v2 candidate): cut the AX snapshot to a char budget, keeping the lines
that matter for the current step. Reference implementation: the harness must build the same view.

Selection = the study's HYB+EXP setup (outputs/action-data/ax-filter-study/REPORT.md):
  round-robin of 4 streams without duplicates -> ranker order (query: the [>] step line), BM25 order
  (query: goal + step), input-role lines, icon-only controls; then [active] lines first and each ranked
  line followed by its parent's small subtree; then lines in rank order with their ancestors while the
  text fits the budget; output in page order between the snapshot header and its closing fence.

  python pageview.py <in.jsonl> <out.jsonl> --ranker <dir> [--budget 4000] [--device cuda]
Rows are swift rows ({"messages": [user, assistant], "images": [...]}); only the AX block of the user
message changes.
"""
import argparse, json, re, sys

# Ref and tag patterns stop at the next '[', so a failed match costs only to there (no
# polynomial backtracking on long lines). Whitespace left by NOISE is collapsed by clean().
REF = re.compile(r'\[ref=([^\]\[]+)\]')
TREE = re.compile(r'^\s*- ')
INPUT_ROLE = re.compile(r"^\s*- '?(textbox|searchbox|combobox|button)\b")
NOISE = re.compile(r'\[(ref|cursor|active|level|checked|expanded|selected|pressed|disabled)[^\]\[]*\]')
GLYPH_ROLE = re.compile(r"^\s*- '?(link|button|generic|img|menuitem|tab)\b(?: \"([^\"]*)\")?")
TOK = re.compile(r'[a-z0-9]+')
STOP = set('the a an to of in on for and or is be by with this that it at as from open click type find tell what which page then into'.split())


def toks(s):
    return [t for t in TOK.findall(s.lower()) if t not in STOP]


def strip_noise(line):
    """NOISE tags removed with the whitespace before each, as `\\s*\\[tag]` did, in linear time."""
    out, pos = [], 0
    for m in NOISE.finditer(line):
        out.append(line[pos:m.start()].rstrip())
        pos = m.end()
    out.append(line[pos:])
    return ''.join(out)


def clean(line):
    s = strip_noise(line).strip()
    s = re.sub(r'^- ', '', s)
    s = s.replace('"', '').replace("'", '')
    return re.sub(r'\s+', ' ', s).strip(': ')


def parse(request):
    """GOAL, current step, and the AX block split into header / tree lines / tail with parents and units."""
    goal = (re.search(r'^GOAL: (.*)$', request, re.M) or [None, ''])[1].strip()
    m = re.search(r'^\[>\](.*)$', request, re.M)
    step = m.group(1).lstrip().lstrip('0123456789').strip() if m else ''
    head, sep, ax = request.partition('\nAX:\n')
    lines = ax.split('\n')
    start = next((i + 1 for i, l in enumerate(lines) if l.startswith('```yaml')), 0)
    end = next((i for i in range(len(lines) - 1, start - 1, -1) if lines[i].startswith('```')), len(lines))
    tree = lines[start:end]
    parent, stack = [-1] * len(tree), []
    for i, l in enumerate(tree):
        if not l.strip():
            continue
        ind = len(l) - len(l.lstrip())
        while stack and stack[-1][1] >= ind:
            stack.pop()
        parent[i] = stack[-1][0] if stack else -1
        if TREE.match(l):
            stack.append((i, ind))
    children = [[] for _ in tree]
    for i, p in enumerate(parent):
        if p >= 0:
            children[p].append(i)

    def desc_text(i, budget=160):
        out, st = [], list(reversed(children[i]))
        while st and sum(len(x) for x in out) < budget:
            j = st.pop()
            c = clean(tree[j])
            if c:
                out.append(c)
            st.extend(reversed(children[j]))
        return ' '.join(out)[:budget]
    units = []
    for i, l in enumerate(tree):
        c = clean(l)
        named = '"' in l or re.search(r':\s*\S', strip_noise(l).split('- ', 1)[-1] if '- ' in l else '')
        extra = desc_text(i) if (REF.search(l) and not named) else ' '.join(
            clean(tree[j]) for j in children[i] if not REF.search(tree[j]))[:160]
        units.append((c + ' ' + extra).strip() if extra else c)
    return dict(goal=goal, step=step, prefix=head + sep, header=lines[:start], tail=lines[end:], tree=tree,
                parent=parent, children=children, units=units, has_ax=bool(sep))


def is_glyph(line):
    m = GLYPH_ROLE.match(line)
    if not m or ('cursor=pointer' not in line and not line.lstrip().startswith(('- link', '- button'))):
        return False
    # The text after the last [ref=…] (and its optional [cursor=pointer] and ':'), by slicing.
    at = line.rfind('[ref=')
    end = line.find(']', at) if at >= 0 else -1
    if end <= at + len('[ref='):
        return False
    rest = line[end + 1:]
    rest = rest[len(' [cursor=pointer]'):] if rest.startswith(' [cursor=pointer]') else rest
    rest = rest[1:] if rest.startswith(':') else rest
    return not re.search(r'[A-Za-z0-9]', (m.group(2) or '') + rest)


def round_robin(*orders):
    out, seen, its, alive = [], set(), [iter(o) for o in orders], True
    while alive:
        alive = False
        for it in its:
            for x in it:
                if x not in seen:
                    seen.add(x); out.append(x); alive = True
                    break
    return out


def expand(r, order, max_sub=12):
    tree, parent, kids = r['tree'], r['parent'], r['children']

    def subtree(p):
        out, st = [], [p]
        while st and len(out) <= max_sub:
            j = st.pop(); out.append(j); st.extend(reversed(kids[j]))
        return out if len(out) <= max_sub else None
    res, seen = [], set()

    def add(i):
        if i not in seen:
            seen.add(i); res.append(i)
    for i, l in enumerate(tree):
        if '[active]' in l and '[ref=' in l:
            add(i)
    for i in order:
        add(i)
        p = parent[i]
        if p >= 0:
            sub = subtree(p)
            if sub:
                for j in sorted(sub):
                    add(j)
    return res


def select_budget(r, order, budget):
    tree, parent = r['tree'], r['parent']
    used = len(r['prefix']) + sum(len(l) + 1 for l in r['header'] + r['tail'])
    picked = set()
    for i in order:
        if i in picked:
            continue
        chain, j = [], i
        while j >= 0 and j not in picked:
            chain.append(j); j = parent[j]
        cost = sum(len(tree[k]) + 1 for k in chain)
        if used + cost > budget + len(r['prefix']):
            continue
        picked.update(chain); used += cost
    return picked


def view(request, scores, budget=4000):
    """The ranked page view for one request, given ranker scores for its tree lines."""
    r = parse(request)
    if not r['has_ax'] or not r['tree']:
        return request
    import numpy as np
    from rank_bm25 import BM25Okapi
    mo = list(np.argsort(-np.asarray(scores), kind='stable'))
    bm = BM25Okapi([toks(u) or ['_'] for u in r['units']])
    bo = list(np.argsort(-np.asarray(bm.get_scores(toks(f"{r['goal']} {r['step']}"))), kind='stable'))
    inputs = [i for i in mo if INPUT_ROLE.match(r['tree'][i]) and REF.search(r['tree'][i])]
    glyphs = [i for i in mo if is_glyph(r['tree'][i])]
    picked = select_budget(r, expand(r, round_robin(mo, bo, inputs, glyphs)), budget)
    body = [r['tree'][i] for i in sorted(picked)]
    return r['prefix'] + '\n'.join(r['header'] + body + r['tail'])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src'); ap.add_argument('dst')
    ap.add_argument('--ranker', required=True)
    ap.add_argument('--budget', type=int, default=4000)
    ap.add_argument('--device', default='cuda')
    a = ap.parse_args()
    from sentence_transformers import CrossEncoder
    model = CrossEncoder(a.ranker, device=a.device, max_length=128)
    n = before = after = 0
    with open(a.dst, 'w') as out:
        for line in open(a.src):
            row = json.loads(line)
            req = row['messages'][0]['content']
            r = parse(req)
            if r['has_ax'] and r['tree']:
                q = r['step'] or r['goal']
                scores = model.predict([(q, u or '-') for u in r['units']], batch_size=512, show_progress_bar=False)
                new = view(req, scores, a.budget)
                before += len(req.split('\nAX:\n', 1)[1]); after += len(new.split('\nAX:\n', 1)[1])
                row['messages'][0]['content'] = new
            out.write(json.dumps(row, ensure_ascii=False) + '\n')
            n += 1
            if n % 5000 == 0:
                print(f'{n} rows, AX chars {before // max(n, 1)} -> {after // max(n, 1)}', flush=True)
    print(json.dumps({'rows': n, 'ax_chars_before': before // max(n, 1), 'ax_chars_after': after // max(n, 1)}))


if __name__ == '__main__':
    main()
