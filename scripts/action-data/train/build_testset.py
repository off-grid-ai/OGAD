#!/usr/bin/env python3
"""Build the frozen test sets from a generator run whose seeds are never used for training.

  python3 build_testset.py --run /workspace/action-data/frozen1 --out /workspace/action-train/test/frozen1
  python3 build_testset.py --run /workspace/action-data/clones-test-a /workspace/action-data/clones-test-b --out ...  (several runs: one set)

Writes <role>.jsonl (ms-swift inference input) and <role>.meta.jsonl (what counts as correct),
aligned by line. Evaluator test keeps every rare verdict and an equal number of `continue`.
"""
import argparse, glob, json, os, random, collections


def parse(line):
    # Generator files may be open for writing: skip a half-written last line.
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None


def rows(runs, kind):
    for run in runs:
        for path in sorted(glob.glob(os.path.join(run, f'{kind}-w*.jsonl'))):
            for line in open(path):
                r = parse(line)
                if r is not None:
                    r['_run'] = run
                    yield r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--run', required=True, nargs='+')
    ap.add_argument('--out', required=True)
    ap.add_argument('--actor', type=int, default=500)
    ap.add_argument('--evaluator', type=int, default=400)
    ap.add_argument('--planner', type=int, default=150)
    ap.add_argument('--actor-per-family', type=int, default=0, help='cap actor rows per family (0 = no cap), so one app does not fill the set')
    a = ap.parse_args()
    rng = random.Random(11)
    os.makedirs(a.out, exist_ok=True)
    done = {}
    for path in [p for run in a.run for p in glob.glob(os.path.join(run, 'episodes-w*.jsonl'))]:
        for line in open(path):
            e = parse(line)
            if e is None:
                continue
            done[e['seed']] = e.get('completed')

    def write(role, items, image, meta):
        with open(os.path.join(a.out, f'{role}.jsonl'), 'w') as f, open(os.path.join(a.out, f'{role}.meta.jsonl'), 'w') as m:
            for r in items:
                out = {'messages': [{'role': 'user', 'content': r['request']}, {'role': 'assistant', 'content': r['response']}]}
                if image:
                    out['images'] = [os.path.join(r['_run'], r['image'])]
                f.write(json.dumps(out) + '\n')
                m.write(json.dumps(meta(r)) + '\n')

    actor = [r for r in rows(a.run, 'actor') if done.get(r['seed'])]
    # One bulk task must not fill the test: at most 5 rows per task.
    per = collections.defaultdict(list)
    for r in actor:
        per[r['seed']].append(r)
    pool = [x for v in per.values() for x in (rng.sample(v, 5) if len(v) > 5 else v)]
    rng.shuffle(pool)
    if a.actor_per_family:
        fam = collections.Counter()
        pool = [r for r in pool if (fam.update([r['family']]) or fam[r['family']] <= a.actor_per_family)]
    actor = pool[:a.actor]
    write('actor', actor, True, lambda r: {'id': r['id'], 'family': r['family'], 'label': r['response'], 'accepted': r['accepted']})

    ev = [r for r in rows(a.run, 'evaluator') if done.get(r['seed'])]
    other = [r for r in ev if not r['response'].startswith('continue(')]
    cont = [r for r in ev if r['response'].startswith('continue(')]
    rng.shuffle(cont)
    ev = other + cont[:max(len(other), a.evaluator - len(other))]
    rng.shuffle(ev)
    ev = ev[:a.evaluator]
    write('evaluator', ev, True, lambda r: {'id': r['id'], 'family': r['family'], 'label': r['response']})

    pl = [r for r in rows(a.run, 'planner') if done.get(r['seed'])]
    rng.shuffle(pl)
    write('planner', pl[:a.planner], False, lambda r: {'id': r['id'], 'kind': r['kind'], 'label': r['response']})

    report = {'actor': len(actor), 'evaluator': len(ev), 'planner': min(len(pl), a.planner),
              'evaluator_verdicts': collections.Counter(r['response'].split('(')[0] for r in ev),
              'actor_families': collections.Counter(r['family'] for r in actor)}
    json.dump(report, open(os.path.join(a.out, 'report.json'), 'w'), indent=1)
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
