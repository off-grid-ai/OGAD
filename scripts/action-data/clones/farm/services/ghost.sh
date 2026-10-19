#!/usr/bin/env bash
# Ghost for blog.farm.test on 127.0.0.1:7136 (sqlite in /dev/shm/clone-farm/ghost; seed copy restored when missing).
export PATH=/opt/node-v24.22.0-linux-x64/bin:$PATH
D=/opt/clone-farm/ghost
[[ -d $D/node_modules ]] || bash /workspace/action-data-gen/scripts/clones/farm/ghost/install.sh
mkdir -p /dev/shm/clone-farm/ghost
[[ -f /dev/shm/clone-farm/ghost/ghost.db || ! -f /workspace/clone-farm/snap/ghost/ghost.db ]] || cp /workspace/clone-farm/snap/ghost/ghost.db /dev/shm/clone-farm/ghost/ghost.db
cd $D && NODE_ENV=production exec node index.js
