#!/usr/bin/env bash
# Etherpad for docs.farm.test on 127.0.0.1:7132 (dirty DB in /dev/shm; seed copy restored when missing).
export PATH=/opt/node-v24.22.0-linux-x64/bin:$PATH
D=/opt/clone-farm/etherpad
[[ -d $D/node_modules ]] || bash /workspace/action-data-gen/scripts/clones/farm/etherpad/install.sh
mkdir -p /dev/shm/clone-farm/etherpad
# pnpm re-links esbuild into the noexec tree on every install: point esbuild at the /workspace copy.
export ESBUILD_BINARY_PATH=$(find /workspace/clone-farm/native/etherpad -name esbuild -type f | head -1)
[[ -f /dev/shm/clone-farm/etherpad/dirty.db || ! -f /workspace/clone-farm/snap/etherpad/dirty.db ]] || cp /workspace/clone-farm/snap/etherpad/dirty.db /dev/shm/clone-farm/etherpad/dirty.db
cd $D/src && NODE_ENV=production exec node --require tsx/cjs node/server.ts --settings $D/settings.json
