"""Ranked page view as a local HTTP service, for the harness (contract v2 candidate).

POST /view {"request": "<full model request whose AX block is the FULL page snapshot>",
            "budget": 4000, "viewport": {"width": 1440, "height": 900} (optional)}
  -> {"request": "<same request, AX cut to the ranked view>", "ms": <ranking time>}

Two stages, so a 3,000-line page stays fast: BM25 (goal + step) picks the top candidates, plus every
input, icon-only control and [active] line; the fine-tuned cross-encoder scores only those. Then the
selection of pageview.view (round-robin streams, row expansion, char budget, page order).
With a viewport, lines whose [box=x,y,w,h] lies outside the visible area get " [offscreen]", and all
box attributes are removed from the output.
  python pageview_server.py --ranker <dir> [--port 8099] [--device cuda] [--candidates 300]
"""
import argparse, json, re, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import numpy as np
import pageview as pv

BOX = re.compile(r' \[box=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]')


def mark_offscreen(request, viewport):
    head, sep, ax = request.partition('\nAX:\n')
    out = []
    for line in ax.split('\n'):
        m = BOX.search(line)
        if m and viewport:
            x, y, w, h = map(float, m.groups())
            off = y + h <= 0 or y >= viewport['height'] or x + w <= 0 or x >= viewport['width'] or (w == 0 and h == 0)
            line = BOX.sub('', line)
            if off and '[ref=e' in line:  # frame content (ref=fN…) has boxes in its own frame's viewport
                line = re.sub(r'(\[ref=[^\]\[]+\])', r'\1 [offscreen]', line, count=1)
        else:
            line = BOX.sub('', line)
        out.append(line)
    return head + sep + '\n'.join(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ranker', required=True); ap.add_argument('--port', type=int, default=8099)
    ap.add_argument('--device', default='cuda'); ap.add_argument('--candidates', type=int, default=300)
    a = ap.parse_args()
    from sentence_transformers import CrossEncoder
    from rank_bm25 import BM25Okapi
    model = CrossEncoder(a.ranker, device=a.device, max_length=128)

    def ranked(request, budget):
        r = pv.parse(request)
        if not r['has_ax'] or not r['tree']:
            return request
        bm = BM25Okapi([pv.toks(u) or ['_'] for u in r['units']])
        bscore = bm.get_scores(pv.toks(f"{r['goal']} {r['step']}"))
        cand = set(np.argsort(-bscore, kind='stable')[:a.candidates].tolist())
        for i, l in enumerate(r['tree']):
            if (pv.INPUT_ROLE.match(l) and pv.REF.search(l)) or pv.is_glyph(l) or ('[active]' in l and '[ref=' in l):
                cand.add(i)
        cand = sorted(cand)
        scores = np.full(len(r['tree']), -1e9, dtype=np.float32)
        if cand:
            q = r['step'] or r['goal']
            scores[cand] = model.predict([(q, r['units'][i] or '-') for i in cand], batch_size=256, show_progress_bar=False)
        return pv.view(request, scores, budget)

    class H(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers['content-length'])))
            t0 = time.perf_counter()
            req = body['request']
            if body.get('viewport'):
                req = mark_offscreen(req, body['viewport'])
            else:
                req = mark_offscreen(req, None)
            out = ranked(req, int(body.get('budget', 4000)))
            data = json.dumps({'request': out, 'ms': round((time.perf_counter() - t0) * 1000)}).encode()
            self.send_response(200); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(data))); self.end_headers()
            self.wfile.write(data)
    print(f'pageview server on :{a.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', a.port), H).serve_forever()


if __name__ == '__main__':
    main()
