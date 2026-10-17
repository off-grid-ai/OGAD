"""Page-backed judge for live benchmark runs: did the run answer the goal correctly, per its final page?

Each task ends as one of: pass, honest_fail (the run did not claim success), false_success (claimed
success with a wrong or empty answer). Clone tasks keep the app-database verdict. The judge is a local
OpenAI-compatible model (Qwen3.8-27B on vLLM); spot-check its verdicts by hand before trusting it.
  python3 judge.py --tasks tasks-v2.json --runs <lineup dir> [...] [--url http://127.0.0.1:8095/v1] [--workers 16]
Writes <lineup>/judged.json and prints per-group counts.
"""
import argparse, concurrent.futures as cf, glob, json, math, os, re, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument('--tasks', required=True); ap.add_argument('--runs', nargs='+', required=True)
ap.add_argument('--url', default='http://127.0.0.1:8095/v1'); ap.add_argument('--model', default='qwen38')
ap.add_argument('--workers', type=int, default=16); ap.add_argument('--page-chars', type=int, default=12000)
a = ap.parse_args()
tasks = {t['id']: t for t in json.load(open(a.tasks))}
words = lambda s: set(re.findall(r'[a-z0-9₹$€.%]+', s.lower()))


def page_excerpt(page, goal, answer, limit):
    """The final page's lines that share the most words with the goal and the answer, in page order."""
    lines = [l for l in page.split('\n') if l.strip()]
    q = words(goal) | words(answer)
    ranked = sorted(range(len(lines)), key=lambda i: -len(q & words(lines[i])))
    keep, used = set(), 0
    for i in ranked:
        if used + len(lines[i]) + 1 > limit:
            continue
        keep.add(i); used += len(lines[i]) + 1
    return '\n'.join(lines[i] for i in sorted(keep))


def ask(goal, answer, page):
    prompt = (f'A browser agent was given this goal:\n{goal}\n\nIts final answer:\n{answer}\n\n'
              f'Text from the final page it was on (accessibility tree, cut to the relevant lines):\n{page}\n\n'
              'Judge the answer only against the goal and this page. "correct": it answers every part of the goal '
              'and the page supports it. "partial": some parts right, some missing or wrong. "wrong": it does not '
              'answer the goal, or the page contradicts it, or it only describes what the agent did.\n'
              'Reply with JSON only: {"verdict": "correct|partial|wrong", "reason": "<one sentence>"}')
    body = json.dumps({'model': a.model, 'messages': [{'role': 'user', 'content': prompt}], 'temperature': 0,
                       'max_tokens': 2000, 'chat_template_kwargs': {'enable_thinking': False}}).encode()
    req = urllib.request.Request(a.url + '/chat/completions', body, {'content-type': 'application/json'})
    text = json.load(urllib.request.urlopen(req, timeout=300))['choices'][0]['message']['content']
    m = re.search(r'\{.*\}', text, re.S)
    try:
        return json.loads(m.group(0)) if m else {'verdict': 'wrong', 'reason': 'unparsable judge reply'}
    except json.JSONDecodeError:
        return {'verdict': 'wrong', 'reason': 'unparsable judge reply'}


def judge_one(path):
    r = json.load(open(path)); t = tasks.get(r.get('id'))
    if not t:
        return None
    out = {'id': r['id'], 'group': t.get('group', 'v1'), 'end': r.get('end')}
    if t.get('app'):
        out['outcome'] = 'pass' if r.get('verified') is True else ('false_success' if r.get('end') == 'success' else 'honest_fail')
        out['reason'] = 'app database'
        return out
    if r.get('end') != 'success':
        out['outcome'] = 'honest_fail'; out['reason'] = r.get('detail', '')[:80]
        return out
    answer = (re.search(r'"(.*)"', r.get('detail') or '', re.S) or [None, ''])[1]
    if not r.get('finalPage'):
        out['outcome'] = 'unjudged'; out['reason'] = 'no final page saved'
        return out
    v = ask(t['goal'], answer, page_excerpt(r['finalPage'], t['goal'], answer, a.page_chars))
    out['answer'] = answer[:200]; out['verdict'] = v.get('verdict'); out['reason'] = v.get('reason', '')[:200]
    out['outcome'] = 'pass' if v.get('verdict') == 'correct' else 'false_success'
    return out


def wilson(k, n, z=1.96):
    if not n:
        return [0, 0]
    p = k / n; d = 1 + z * z / n; c = (p + z * z / (2 * n)) / d; h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return [round(c - h, 3), round(c + h, 3)]


for d in a.runs:
    files = [f for f in glob.glob(os.path.join(d, '*.json')) if not os.path.basename(f).startswith(('summary', 'graded', 'judged'))]
    with cf.ThreadPoolExecutor(a.workers) as ex:
        res = [x for x in ex.map(judge_one, files) if x]
    json.dump(res, open(os.path.join(d, 'judged.json'), 'w'), indent=1, ensure_ascii=False)
    groups = {}
    for x in res:
        g = groups.setdefault(x['group'], {'pass': 0, 'false_success': 0, 'honest_fail': 0, 'unjudged': 0})
        g[x['outcome']] += 1
    k = sum(x['outcome'] == 'pass' for x in res); n = sum(x['outcome'] != 'unjudged' for x in res)
    print(json.dumps({'lineup': os.path.basename(d.rstrip('/')), 'pass': k, 'judged': n, 'rate': round(k / n, 3) if n else 0,
                      'ci95': wilson(k, n), 'false_success': sum(x['outcome'] == 'false_success' for x in res),
                      'groups': {g: f"{v['pass']}/{v['pass'] + v['false_success'] + v['honest_fail']} (false {v['false_success']})" for g, v in groups.items()}}))
