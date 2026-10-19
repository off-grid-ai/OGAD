#!/usr/bin/env bash
# Reset every seeded EtherCalc sheet to its seed snapshot via the REST API (PUT text/x-socialcalc), ~0.5 s.
# Works after a pod restart too (the room store in /dev/shm is simply refilled).
set -e
SNAP=/workspace/clone-farm/snap/ethercalc
ls $SNAP/*.sc | xargs -P 16 -I{} sh -c 'r=$(basename {} .sc); curl -sf -o /dev/null -X PUT -H "Content-Type: text/x-socialcalc" --data-binary @{} http://127.0.0.1:7130/_/$r || echo "reset failed: $r" >&2'
