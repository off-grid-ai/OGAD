"""Turn teacher task folders into the run files grade.py reads (<id>.json with end + detail).
  python3 to-grade.py <teacher_out>
"""
import json, re, sys
from pathlib import Path

src = Path(sys.argv[1])
for d in sorted(p for p in src.iterdir() if p.is_dir() and (p / f'{p.name}.done').exists()):
    ep = d / 'episodes.jsonl'
    end = json.loads(ep.read_text().splitlines()[-1])['end'] if ep.exists() and ep.read_text().strip() else 'no-finish'
    ev = [json.loads(l) for l in open(d / 'evaluator.jsonl')] if (d / 'evaluator.jsonl').exists() else []
    last = next((r for r in ev if r['id'].endswith(':end')), None)
    answer = (last or {}).get('answer') or ''
    # The full final page (boxed snapshot), not the 18k cut: the teacher read a 60k view.
    boxed = (d / 'boxed.jsonl').read_text().strip().splitlines() if (d / 'boxed.jsonl').exists() else []
    page = re.sub(r' \[box=[^\]]*\]', '', json.loads(boxed[-1])['boxed']) if boxed else (last or {}).get('request', '').split('\nAX:\n', 1)[-1]
    (src / f'{d.name}.json').write_text(json.dumps({'id': d.name, 'end': end, 'detail': f'success({json.dumps(answer, ensure_ascii=False)})' if end == 'success' else end, 'finalPage': page}, ensure_ascii=False))
