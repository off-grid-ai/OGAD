#!/usr/bin/env python3
"""Reset Etherpad to the seed through its HTTP API (~0.3 s): every seed pad whose HTML differs from the seed is
restored to its seed revision (restoreRevision), every pad that is not in the seed is deleted.
If the pad store is empty (pod restart), re-run the seed script instead."""
import json, subprocess, sys, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

KEY = open('/workspace/clone-farm/etherpad/APIKEY.txt').read().strip()
API = 'http://127.0.0.1:7132/api/1.3.0'
FACTS = json.load(open('/workspace/clone-farm/snap/etherpad/facts.json'))


def call(fn, **p):
    with urllib.request.urlopen(f'{API}/{fn}?' + urllib.parse.urlencode({'apikey': KEY, **p}), timeout=30) as r:
        return json.load(r)


live = set(call('listAllPads')['data']['padIDs'])
if not set(FACTS) <= live:
    subprocess.run([sys.executable, '/workspace/action-data-gen/scripts/clones/seed/etherpad_seed.py'], check=True)
    sys.exit(0)


def fix(pid):
    if pid not in FACTS:
        call('deletePad', padID=pid); return 1
    if call('getHTML', padID=pid)['data']['html'] != FACTS[pid]['html']:
        call('restoreRevision', padID=pid, rev=FACTS[pid]['rev']); return 1
    return 0


with ThreadPoolExecutor(8) as ex:
    n = sum(ex.map(fix, live))
print(f'reset {n} pads')
