#!/usr/bin/env python3
"""Pick Mind2Web steps for the real-site actor test and save what the capture step needs.

  python prepare_mind2web.py --shards '/path/train-*.parquet' --out /workspace/action-train/realsite/m2w1 --count 600

For each step: the saved page HTML, a viewport-size crop of the real screenshot around the
target, and meta (task, recorded target ids, operation, plan written from the recorded steps,
and the earlier steps as PAST lines). The new models never train on Mind2Web, so any step is
held out.
"""
import argparse, glob, io, json, os, random, re

import pyarrow.parquet as pq
from PIL import Image

VIEW_W, VIEW_H = 1280, 800


def parse_repr(text):
    """'[combobox]  Enter city -> TYPE: Pune' → (op, target text, value)."""
    m = re.match(r'^\[(?P<role>[^\]]*)\]\s*(?P<target>.*?)\s*->\s*(?P<op>CLICK|TYPE|SELECT|HOVER|ENTER)(?::\s*(?P<value>.*))?$', text.strip())
    if not m:
        return None
    target = (m.group('target') or m.group('role') or '').strip()[:60]
    return m.group('op'), target, (m.group('value') or '').strip()


def step_title(op, target, value):
    if op == 'TYPE':
        return f'Type {value} in {target}'
    if op == 'SELECT':
        return f'Select {value} in {target}'
    return f'Click {target}'


def past_line(op, target, value):
    q = json.dumps
    if op == 'TYPE':
        return f'type({q(target)},{q(value)}) -> ok, page changed'
    if op == 'SELECT':
        return f'select({q(target)},{q(value)}) -> ok, page changed'
    return f'click({q(target)}) -> ok, page changed'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--shards', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--count', type=int, default=600)
    ap.add_argument('--seed', type=int, default=5)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    os.makedirs(os.path.join(a.out, 'html'), exist_ok=True)
    os.makedirs(os.path.join(a.out, 'images'), exist_ok=True)
    shards = sorted(glob.glob(a.shards))
    rng.shuffle(shards)
    per_shard = a.count // max(1, min(len(shards), 6)) + 1
    meta, seen_tasks = [], set()
    for shard in shards[:6]:
        table = pq.read_table(shard)
        rows = list(range(table.num_rows))
        rng.shuffle(rows)
        taken = 0
        for i in rows:
            if taken >= per_shard or len(meta) >= a.count:
                break
            r = table.slice(i, 1).to_pylist()[0]
            if r['annotation_id'] in seen_tasks:
                continue  # one step per task, so no task dominates
            op = json.loads(r['operation'])
            if op['op'] not in ('CLICK', 'TYPE', 'SELECT') or not r['pos_candidates']:
                continue
            gold = [json.loads(c) for c in r['pos_candidates']]
            ids = [g['backend_node_id'] for g in gold]
            attrs = json.loads(gold[0]['attributes'])
            box = [float(x) for x in attrs.get('bounding_box_rect', '0,0,0,0').split(',')]
            reprs = [parse_repr(x) for x in r['action_reprs']]
            if any(x is None for x in reprs):
                continue
            current = int(r['target_action_index'])
            shot = r['screenshot'] and r['screenshot'].get('bytes')
            if not shot:
                continue
            img = Image.open(io.BytesIO(shot)).convert('RGB')
            top = int(max(0, min(box[1] + box[3] / 2 - VIEW_H / 2, img.height - VIEW_H)))
            uid = r['action_uid']
            img.crop((0, top, min(VIEW_W, img.width), top + VIEW_H)).save(os.path.join(a.out, 'images', f'{uid}.jpg'), quality=70)
            with open(os.path.join(a.out, 'html', f'{uid}.html'), 'w') as f:
                f.write(r['raw_html'])
            meta.append({
                'id': uid, 'task': r['confirmed_task'], 'website': r['website'], 'domain': r['domain'],
                'op': op['op'], 'value': op.get('value', ''), 'gold_ids': ids,
                'plan': [{'title': step_title(*x)} for x in reprs],
                'current': current + 1,
                'past': [past_line(*x) for x in reprs[:current]],
                'image': f'images/{uid}.jpg'
            })
            seen_tasks.add(r['annotation_id'])
            taken += 1
    with open(os.path.join(a.out, 'meta.jsonl'), 'w') as f:
        for m in meta:
            f.write(json.dumps(m) + '\n')
    print(json.dumps({'steps': len(meta), 'ops': {o: sum(m['op'] == o for m in meta) for o in ('CLICK', 'TYPE', 'SELECT')}}))


if __name__ == '__main__':
    main()
