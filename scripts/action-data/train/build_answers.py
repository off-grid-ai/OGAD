"""Build planner answer rows: the final page in, the complete answer out (contract: answerRequest).

Source: teacher evaluator rows that say success("...") with an answer. A row is kept only when
>= 60% of the answer's words appear on the page it was read from, so the planner learns to copy
facts from the page, not to invent them. One row per (goal, answer).
  python3 build_answers.py <out.jsonl> <run_dir> [<run_dir> ...] [--mix planner.jsonl]
--mix appends existing planner rows so the planner keeps planning.
"""
import glob, json, os, random, re, sys

ANSWER_TASK = 'TASK: write the complete answer to the goal from this page.'
norm = lambda t: re.sub(r'[^a-z0-9₹$€.%]+', ' ', t.lower()).strip()

argv = sys.argv[1:]
mix = None
if '--mix' in argv:
    i = argv.index('--mix'); mix = argv[i + 1]; argv = argv[:i] + argv[i + 2:]
out, runs = argv[0], argv[1:]
rows, seen, dropped = [], set(), 0
for run in runs:
    for path in sorted(glob.glob(os.path.join(run, 'evaluator-w*.jsonl'))):
        for line in open(path):
            r = json.loads(line)
            answer = (r.get('answer') or '').strip()
            if not r['response'].startswith('success(') or not answer or '\nAX:\n' not in r['request']:
                continue
            goal = r['request'].split('\n', 1)[0].removeprefix('GOAL: ').strip()
            ax = r['request'].split('\nAX:\n', 1)[1]
            words = [w for w in norm(answer).split() if len(w) > 2]
            page = norm(ax)
            if not words or sum(w in page for w in words) / len(words) < 0.6:
                dropped += 1
                continue
            key = (goal, norm(answer))
            if key in seen:
                continue
            seen.add(key)
            request = '\n'.join([f'GOAL: {goal}', ANSWER_TASK, 'AX:', ax])
            rows.append({'messages': [{'role': 'user', 'content': request}, {'role': 'assistant', 'content': answer}]})
answers = len(rows)
if mix:
    rows += [json.loads(l) for l in open(mix)]
random.Random(7).shuffle(rows)
with open(out, 'w') as f:
    for r in rows:
        f.write(json.dumps(r, ensure_ascii=False) + '\n')
print(json.dumps({'answers': answers, 'dropped_not_on_page': dropped, 'mixed_planner_rows': len(rows) - answers, 'total': len(rows)}))
