#!/usr/bin/env python3
"""Find clone-run rows whose screenshot is unreadable (empty or cut off: a write failed) or was
overwritten by a later run in the same folder (image names before the seed was in them restarted at 0).

  python3 check_images.py /workspace/action-data/clones-*            report only
  python3 check_images.py --fix /workspace/action-data/clones-*      move those rows to rejected-<role>-w*.jsonl

A test or training set that hits one bad image crashes, so run this before building a set.
"""
import argparse, glob, json, os, re

from PIL import Image


def readable(path, cache={}):
    if path not in cache:
        try:
            with Image.open(path) as im:
                im.load()
            cache[path] = True
        except Exception:
            cache[path] = False
    return cache[path]


def overwritten_by_later_run(run):
    """Old-style names (<app>-w0-<n>.jpg) shared by two seeds: the earlier seed's rows lost their images."""
    seen = {}  # image -> set of seeds
    order = []
    for path in sorted(glob.glob(os.path.join(run, 'episodes-w*.jsonl'))):
        for line in open(path):
            s = json.loads(line)['seed'].split(':')[3]
            if s not in order:
                order.append(s)
    for path in sorted(glob.glob(os.path.join(run, '*-w*.jsonl'))):
        if os.path.basename(path).startswith(('episodes', 'rejected')):
            continue
        for line in open(path):
            r = json.loads(line)
            if 'image' in r and re.match(r'images/[^/]+-w\d+-\d+\.jpg$', r['image']):
                seen.setdefault(r['image'], set()).add(r['seed'].split(':')[3])
    bad = set()
    for image, seeds in seen.items():
        if len(seeds) > 1:  # keep the newest seed's rows, which match what is on disk
            newest = max(seeds, key=order.index)
            bad |= {(image, s) for s in seeds if s != newest}
    return bad


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--fix', action='store_true')
    ap.add_argument('runs', nargs='+')
    a = ap.parse_args()
    for run in a.runs:
        if not os.path.isdir(run) or run.rstrip('/').endswith('clones-dev'):
            continue
        clobbered = overwritten_by_later_run(run)
        total = dropped = 0
        for path in sorted(glob.glob(os.path.join(run, '*-w*.jsonl'))):
            name = os.path.basename(path)
            if name.startswith(('episodes', 'rejected', 'planner')):
                continue
            keep, reject = [], []
            for line in open(path):
                r = json.loads(line)
                total += 1
                img = r.get('image')
                bad = img and (not readable(os.path.join(run, img)) or (img, r['seed'].split(':')[3]) in clobbered)
                (reject if bad else keep).append(line)
            dropped += len(reject)
            if a.fix and reject:
                with open(os.path.join(run, f'rejected-{name}'), 'a') as f:
                    f.writelines(reject)
                tmp = path + '.tmp'
                with open(tmp, 'w') as f:
                    f.writelines(keep)
                os.replace(tmp, path)
        print(f'{os.path.basename(run.rstrip("/")):26s} rows {total:6d}  bad image {dropped:5d}  (overwritten {len(clobbered)})' + ('  fixed' if a.fix and dropped else ''))


if __name__ == '__main__':
    main()
