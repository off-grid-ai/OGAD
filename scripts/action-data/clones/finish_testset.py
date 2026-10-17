#!/usr/bin/env python3
"""Make a built test set self-contained (images copied into <set>/images) and write capture-summary.json.
  finish_testset.py <built dir> <final dir> <held-out app>...
Build into a temp dir, run this with the final path (image paths are written for it), then rename into place."""
import json, os, shutil, sys, collections
out, final = sys.argv[1], sys.argv[2]
os.makedirs(os.path.join(out, 'images'), exist_ok=True)
summary = {'roles': {}, 'apps': collections.Counter(), 'note': 'Held-out clone apps (never trained on): ' + ', '.join(sys.argv[3:])}
for role in ['actor', 'evaluator', 'planner']:
    p = os.path.join(out, f'{role}.jsonl')
    if not os.path.exists(p):
        continue
    rows = [json.loads(l) for l in open(p)]
    for r in rows:
        if 'images' in r:
            new = []
            for src in r['images']:
                dst = os.path.join(out, 'images', os.path.basename(src))
                if not os.path.exists(dst):
                    shutil.copyfile(src, dst)
                new.append(os.path.join(final, 'images', os.path.basename(src)))
            r['images'] = new
    with open(p, 'w') as f:
        f.write(''.join(json.dumps(r) + '\n' for r in rows))
    summary['roles'][role] = len(rows)
for l in open(os.path.join(out, 'actor.meta.jsonl')):
    summary['apps'][json.loads(l)['id'].split(':')[1]] += 1
summary['written'] = summary['roles'].get('actor', 0)
json.dump(summary, open(os.path.join(out, 'capture-summary.json'), 'w'), indent=1)
print(json.dumps(summary))
