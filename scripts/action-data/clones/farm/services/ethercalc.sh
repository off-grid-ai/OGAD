#!/usr/bin/env bash
# EtherCalc (TypeScript/workerd rewrite) for sheets.farm.test on 127.0.0.1:7130.
# Tree in /dev/shm (/opt/clone-farm -> /dev/shm/clone-farm/opt), native workerd on /workspace (farm/data/natives.sh).
# /dev/shm is noexec, so shebang scripts cannot be exec'd: run wrangler through node (what bin/ethercalc does via bunx).
# Room state persists in /dev/shm/clone-farm/ethercalc; farm/ethercalc/reset.sh restores the seed via the REST API.
export PATH=/opt/node-v24.22.0-linux-x64/bin:$PATH
D=/opt/clone-farm/ethercalc
[[ -d $D/node_modules ]] || bash /workspace/action-data-gen/scripts/clones/farm/ethercalc/install.sh
mkdir -p /dev/shm/clone-farm/ethercalc
cd $D/packages/worker || exit 1
export ETHERCALC_PORT=7130 ETHERCALC_HOST=127.0.0.1
( sleep 25; bash /workspace/clone-farm/ethercalc/reset.sh ) &
exec node ../../node_modules/wrangler/bin/wrangler.js dev --port 7130 --ip 127.0.0.1 --persist-to /dev/shm/clone-farm/ethercalc
