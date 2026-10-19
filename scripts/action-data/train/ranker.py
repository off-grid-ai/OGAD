"""Fine-tune a small cross-encoder that ranks AX lines for the current plan step (the "page filter").

Training pairs come from actor rows: the query is the current step (+ goal), the positive is the AX
line that carries the gold ref, negatives are other lines of the same page (half the most similar by
word overlap, half random). Test = the held-out realsite sets (never trained on).
  python ranker.py --runs <run dirs...> --test <realsite set dirs...> --out <dir> [--base cross-encoder/ms-marco-MiniLM-L6-v2]
Reports gold-ref recall@K for the base and the fine-tuned model.
"""
import argparse, glob, json, os, random, re

REF = re.compile(r'\[ref=((?:f\d+)?e\d+)\]')
GOLD = re.compile(r'^\w+\(((?:f\d+)?e\d+)')
NOISE = re.compile(r'\s*\[(?:ref|cursor|box)=[^\]]*\]')


def parse(request, response):
    lines = request.split('\n')
    goal = lines[0].removeprefix('GOAL: ').strip()
    step = next((l.split(' ', 2)[-1] for l in lines if l.startswith('[>]')), '')
    ax = request.split('\nAX:\n', 1)[-1].split('\n')
    cands = [(m.group(1), NOISE.sub('', l).strip(' -:')) for l in ax for m in [REF.search(l)] if m]
    g = GOLD.match(response.strip())
    return goal, step, cands, (g.group(1) if g else None)


def query(goal, step):
    return f'{step} || {goal}' if step else goal


def words(t):
    return set(re.findall(r'[a-z0-9]+', t.lower()))


def rows_from(path, limit=None):
    out = []
    for line in open(path):
        r = json.loads(line)
        if 'messages' in r:
            req, resp = r['messages'][0]['content'], r['messages'][1]['content']
        else:
            req, resp = r['request'], r['response']
        goal, step, cands, gold = parse(req, resp)
        if gold and any(ref == gold for ref, _ in cands) and len(cands) > 3:
            out.append((goal, step, cands, gold))
        if limit and len(out) >= limit:
            break
    return out


def recall(model, rows, ks=(10, 20, 40, 80), batch=256):
    hits = {k: 0 for k in ks}
    for goal, step, cands, gold in rows:
        q = query(goal, step)
        scores = model.predict([(q, t) for _, t in cands], batch_size=batch, show_progress_bar=False)
        order = [cands[i][0] for i in sorted(range(len(cands)), key=lambda i: -scores[i])]
        rank = order.index(gold)
        for k in ks:
            hits[k] += rank < k
    return {f'R@{k}': round(100 * hits[k] / len(rows), 1) for k in ks}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs', nargs='+', required=True)
    ap.add_argument('--test', nargs='+', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--base', default='cross-encoder/ms-marco-MiniLM-L6-v2')
    ap.add_argument('--max-rows', type=int, default=60000)
    ap.add_argument('--negs', type=int, default=15)
    ap.add_argument('--epochs', type=int, default=1)
    a = ap.parse_args()
    from sentence_transformers import CrossEncoder, InputExample
    from torch.utils.data import DataLoader
    rng = random.Random(7)

    train = []
    files = [f for d in a.runs for f in glob.glob(os.path.join(d, 'actor-w*.jsonl'))]
    rng.shuffle(files)
    for f in files:
        train += rows_from(f)
    rng.shuffle(train)
    train = train[:a.max_rows]
    test = {os.path.basename(d.rstrip('/')): rows_from(os.path.join(d, 'actor.jsonl')) for d in a.test}
    print(json.dumps({'train_rows': len(train), 'test_rows': {k: len(v) for k, v in test.items()}}), flush=True)

    examples = []
    for goal, step, cands, gold in train:
        q = query(goal, step)
        pos = next(t for ref, t in cands if ref == gold)
        others = [(ref, t) for ref, t in cands if ref != gold]
        qw = words(q)
        hard = sorted(others, key=lambda c: -len(qw & words(c[1])))[:a.negs // 2]
        rest = [c for c in others if c not in hard]
        negs = hard + rng.sample(rest, min(len(rest), a.negs - len(hard)))
        examples.append(InputExample(texts=[q, pos], label=1.0))
        examples += [InputExample(texts=[q, t], label=0.0) for _, t in negs]

    base = CrossEncoder(a.base, num_labels=1, max_length=128)
    report = {'base': {k: recall(base, v) for k, v in test.items()}}
    print(json.dumps(report), flush=True)
    base.fit(train_dataloader=DataLoader(examples, shuffle=True, batch_size=128), epochs=a.epochs, warmup_steps=200, show_progress_bar=False)
    base.save(a.out)
    report['tuned'] = {k: recall(base, v) for k, v in test.items()}
    json.dump(report, open(os.path.join(a.out, 'report.json'), 'w'), indent=1)
    print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
