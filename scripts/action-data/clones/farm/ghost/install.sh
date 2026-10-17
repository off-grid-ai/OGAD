#!/usr/bin/env bash
# Rebuild Ghost (npm package, sqlite) from scratch in /dev/shm via /opt/clone-farm (natives moved to /workspace). Never /workspace (quota).
set -e
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
export PATH=/opt/node-v24.22.0-linux-x64/bin:$PATH
V=6.71.0
D=/opt/clone-farm/ghost
if [[ ! -f $D/index.js ]]; then mkdir -p $D && cd $D/.. && npm pack ghost@$V >/dev/null && tar --no-same-owner -xzf ghost-$V.tgz -C . && rm -rf $D && mv package $D && rm ghost-$V.tgz; fi
cd $D && pnpm install --prod --store-dir /dev/shm/clone-farm/.pnpm-store --config.confirmModulesPurge=false
cp /workspace/action-data-gen/scripts/clones/farm/ghost/config.production.json $D/config.production.json
# Native files to /workspace (exec allowed; /dev/shm is noexec).
bash /workspace/action-data-gen/scripts/clones/farm/data/natives.sh ghost /opt/clone-farm/ghost
