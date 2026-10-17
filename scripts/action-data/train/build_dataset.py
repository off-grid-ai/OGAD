#!/usr/bin/env python3
"""Turn generator rows into ms-swift training files, one per model.

  python3 build_dataset.py --runs /workspace/action-data/run1 /workspace/action-data/run1-mac \
      --out /workspace/action-train/data/r1 [--actor-max 15000] [--evaluator-max 8000]

Balancing (all seeded, so a rebuild gives the same files):
- Actor: bulk tasks give long runs of near-identical rows. At most --bulk-cap rows per bulk task.
- Evaluator: `continue` is about 95% of raw rows. Keep every other verdict; keep `continue`
  at --continue-ratio times the others.
- Planner: every row (plans and re-plans).
Requests already follow docs/MODEL_CONTRACT.md; `<image>` in a request marks where the image goes.
"""
import argparse, glob, json, os, random, collections


def parse(line):
    # Generator files may be open for writing: skip a half-written last line.
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None


def load(run_dirs, kind):
    for run in run_dirs:
        for path in sorted(glob.glob(os.path.join(run, f'{kind}-w*.jsonl'))):
            with open(path) as f:
                for line in f:
                    row = parse(line)
                    if row is None:
                        continue
                    row['_run'] = run
                    yield row


def family_of_seed(run_dirs):
    out = {}
    for run in run_dirs:
        for path in glob.glob(os.path.join(run, 'episodes-w*.jsonl')):
            for line in open(path):
                e = parse(line)
                if e is None:
                    continue
                out[e['seed']] = (e.get('family'), e.get('completed'))
    return out


def swift_row(row, image=True):
    msg = [{'role': 'user', 'content': row['request']}, {'role': 'assistant', 'content': row['response']}]
    out = {'messages': msg}
    if image:
        out['images'] = [os.path.join(row['_run'], row['image'])]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs', nargs='+', required=True)
    ap.add_argument('--planner-runs', nargs='+', help='runs for planner rows (default: --runs); use when older runs have outdated plan labels')
    ap.add_argument('--out', required=True)
    ap.add_argument('--actor-max', type=int, default=15000)
    ap.add_argument('--evaluator-max', type=int, default=8000)
    ap.add_argument('--planner-max', type=int, default=4000)
    ap.add_argument('--bulk-cap', type=int, default=12)
    ap.add_argument('--continue-ratio', type=float, default=1.5)
    ap.add_argument('--success-share', type=float, default=0.0, help='cap success rows at this share of kept evaluator rows (0 = no cap)')
    ap.add_argument('--seed', type=int, default=7)
    ap.add_argument('--keep-family', default='', help='families kept whole, outside the balanced share and --actor-max (e.g. ground)')
    ap.add_argument('--keep-max', type=int, default=0, help='cap on rows kept from --keep-family families (0 = all)')
    ap.add_argument('--upweight', default='', help='family=times, comma-separated: repeat that family\'s actor rows (e.g. teacher=4)')
    a = ap.parse_args()
    rng = random.Random(a.seed)
    os.makedirs(a.out, exist_ok=True)
    episodes = family_of_seed(a.runs)
    report = {'runs': a.runs, 'planner_runs': a.planner_runs or a.runs}

    # Only rows from tasks that finished cleanly: a dropped task may end on an unchecked state.
    good = lambda r: episodes.get(r['seed'], (None, False))[1]

    actor = [r for r in load(a.runs, 'actor') if good(r)]
    by_task = collections.defaultdict(list)
    for r in actor:
        by_task[r['seed']].append(r)
    kept = []
    for seed, rows in by_task.items():
        if rows[0]['family'] == 'bulk' and len(rows) > a.bulk_cap:
            rows = rng.sample(rows, a.bulk_cap)
        kept.extend(rows)
    # The model's own mistakes (on-policy rows where it chose wrong) are always kept: they are the
    # most useful rows we have. The rest is balanced across task types.
    mistakes = [r for r in kept if r.get('policy_wrong')]
    kept = [r for r in kept if not r.get('policy_wrong')]
    a.actor_max = max(0, a.actor_max - len(mistakes))
    # Balance task types: each family gets an equal share; unused share goes to the others.
    keep_all = set(filter(None, a.keep_family.split(',')))
    whole = [r for r in kept if r['family'] in keep_all]
    if a.keep_max and len(whole) > a.keep_max:
        rng.shuffle(whole)
        whole = whole[:a.keep_max]
    kept = [r for r in kept if r['family'] not in keep_all]
    by_family = collections.defaultdict(list)
    for r in kept:
        by_family[r['family']].append(r)
    for rows in by_family.values():
        rng.shuffle(rows)
    share = a.actor_max // max(1, len(by_family))
    picked = [r for rows in by_family.values() for r in rows[:share]]
    rest = [r for rows in by_family.values() for r in rows[share:]]
    rng.shuffle(rest)
    kept = picked + rest[:max(0, a.actor_max - len(picked))] + mistakes + whole
    # Upweight scarce, high-value families (teacher runs on the product's real sites).
    for spec in filter(None, a.upweight.split(',')):
        fam, times = spec.split('=')
        extra = [r for r in kept if r['family'] == fam]
        kept += extra * (int(times) - 1)
    rng.shuffle(kept)
    report['actor'] = {'raw': len(actor), 'kept': len(kept), 'tasks': len(by_task), 'mistakes': len(mistakes),
                       'families': collections.Counter(r['family'] for r in kept),
                       'actions': collections.Counter(r['response'].split('(')[0] for r in kept)}
    with open(os.path.join(a.out, 'actor.jsonl'), 'w') as f:
        for r in kept:
            f.write(json.dumps(swift_row(r)) + '\n')

    ev = [r for r in load(a.runs, 'evaluator') if good(r)]
    other = [r for r in ev if not r['response'].startswith('continue(')]
    cont = [r for r in ev if r['response'].startswith('continue(')]
    rng.shuffle(cont)
    rng.shuffle(other)
    if a.success_share:
        # Too many success rows teach the evaluator to stop early (round 5e: 87 of 193 continue -> success).
        succ = [r for r in other if r['response'].startswith('success(')]
        rest = [r for r in other if not r['response'].startswith('success(')]
        cap = int(a.evaluator_max * a.success_share)
        other = rest + succ[:cap]
    cont = cont[:int(len(other) * a.continue_ratio)]
    ev_kept = other + cont
    rng.shuffle(ev_kept)
    ev_kept = ev_kept[:a.evaluator_max]
    report['evaluator'] = {'raw': len(ev), 'kept': len(ev_kept),
                           'verdicts': collections.Counter(r['response'].split('(')[0] for r in ev_kept)}
    with open(os.path.join(a.out, 'evaluator.jsonl'), 'w') as f:
        for r in ev_kept:
            f.write(json.dumps(swift_row(r)) + '\n')

    planner_runs = a.planner_runs or a.runs
    if a.planner_runs:
        episodes.update(family_of_seed(planner_runs))
    pl = [r for r in load(planner_runs, 'planner') if good(r)]
    rng.shuffle(pl)
    pl = pl[:a.planner_max]
    report['planner'] = {'raw': len(pl), 'kept': len(pl), 'kinds': collections.Counter(r['kind'] for r in pl)}
    with open(os.path.join(a.out, 'planner.jsonl'), 'w') as f:
        for r in pl:
            f.write(json.dumps(swift_row(r, image=False)) + '\n')

    with open(os.path.join(a.out, 'report.json'), 'w') as f:
        json.dump(report, f, indent=1, default=dict)
    print(json.dumps(report, indent=1, default=dict))


if __name__ == '__main__':
    main()
