#!/usr/bin/env bash
# Rebuild EtherCalc from scratch. The tree lives in /dev/shm (/opt/clone-farm -> /dev/shm/clone-farm/opt), native
# binaries (workerd, esbuild...) go to /workspace/clone-farm/native/ethercalc (exec allowed; /dev/shm is noexec).
# Built static assets come from the snapshot /workspace/clone-farm/snap/ethercalc-assets.tgz (the asset build runs
# native bundlers that cannot start from /dev/shm before natives.sh has run).
set -e
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
export PATH=/opt/node-v24.22.0-linux-x64/bin:$PATH BUN_INSTALL_CACHE_DIR=/dev/shm/clone-farm/.bun-cache
command -v bun >/dev/null || npm i -g bun
D=/opt/clone-farm/ethercalc
if [[ ! -d $D ]]; then git clone --depth 1 https://github.com/audreyt/ethercalc.git $D; fi
cd $D && bun install --ignore-scripts
bash /workspace/action-data-gen/scripts/clones/farm/data/natives.sh ethercalc $D
if [[ -f /workspace/clone-farm/snap/ethercalc-assets.tgz ]]; then tar --no-same-owner -xzf /workspace/clone-farm/snap/ethercalc-assets.tgz -C $D
else bun run build:assets && bash /workspace/action-data-gen/scripts/clones/farm/data/natives.sh ethercalc $D; fi
