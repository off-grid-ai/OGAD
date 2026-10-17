#!/usr/bin/env python3
"""Score ms-swift inference results against the frozen test meta files.

  python3 score.py --role actor --meta test/frozen1/actor.meta.jsonl --pred runs/x/actor-pred.jsonl

Actor: correct when the reply is one of the accepted actions (`*` in an accepted action matches
any text). Evaluator: `continue(n)` must match exactly; other verdicts must match by name, and a
`success` answer must contain the expected answer. Planner: exact plan, and step titles in order.
Also reports false `success` (the costliest evaluator error).
"""
import argparse, json, re, collections


def reply(pred):
    text = (pred.get('response') or '').strip()
    text = re.sub(r'^<think>.*?</think>\s*', '', text, flags=re.S)
    return text.splitlines()[0].strip() if text else ''


def glob_match(pattern, text):
    rx = '^' + '.*'.join(re.escape(p) for p in pattern.split('*')) + '$'
    return re.match(rx, text, flags=re.S) is not None


def verdict_name(text):
    return text.split('(')[0].strip()


def arg(text):
    m = re.match(r'^\w+\((.*)\)$', text, flags=re.S)
    if not m:
        return ''
    try:
        return json.loads(m.group(1)) if m.group(1).startswith('"') else m.group(1)
    except Exception:
        return m.group(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--role', required=True, choices=['actor', 'evaluator', 'planner'])
    ap.add_argument('--meta', required=True)
    ap.add_argument('--pred', required=True)
    ap.add_argument('--out')
    a = ap.parse_args()
    meta = [json.loads(l) for l in open(a.meta)]
    pred = [json.loads(l) for l in open(a.pred)]
    assert len(meta) == len(pred), f'{len(meta)} meta rows, {len(pred)} predictions'
    report = {'role': a.role, 'examples': len(meta), 'correct': 0, 'groups': collections.defaultdict(lambda: [0, 0]), 'errors': []}
    for m, p in zip(meta, pred):
        got = reply(p)
        if a.role == 'actor':
            ok = any(glob_match(x, got) for x in m['accepted'])
            group = m['label'].split('(')[0]
        elif a.role == 'evaluator':
            want = m['label']
            name = verdict_name(want)
            if name == 'continue':
                ok = got == want
            elif name == 'success':
                ok = verdict_name(got) == 'success' and str(arg(want)).lower() in str(arg(got)).lower()
            else:
                ok = verdict_name(got) == name
            group = name
            if verdict_name(got) == 'success' and name != 'success':
                report.setdefault('false_success', 0)
                report['false_success'] += 1
        else:
            want = m['label']
            full = (p.get('response') or '').strip()
            ok = full == want
            title = lambda s: [re.sub(r'^\d+\s+', '', l).split(' | check:')[0] for l in s.splitlines() if l.strip()]
            report.setdefault('step_titles_in_order', 0)
            report['step_titles_in_order'] += int(title(full) == title(want))
            group = m['kind']
        report['correct'] += int(ok)
        g = report['groups'][group]
        g[0] += int(ok)
        g[1] += 1
        if not ok and len(report['errors']) < 40:
            report['errors'].append({'id': m['id'], 'want': m.get('label'), 'got': got[:200]})
    report['rate'] = round(report['correct'] / max(1, len(meta)), 4)
    report['groups'] = {k: {'correct': v[0], 'total': v[1]} for k, v in report['groups'].items()}
    text = json.dumps(report, indent=1)
    if a.out:
        open(a.out, 'w').write(text)
    print(text)


if __name__ == '__main__':
    main()
