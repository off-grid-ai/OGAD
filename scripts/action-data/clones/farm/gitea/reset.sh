#!/usr/bin/env bash
# Reset Gitea to the seed: stop, copy the seed data dir back (sqlite + repos), start. ~3 s.
set -e
F=/workspace/clone-farm; D=/dev/shm/clone-farm
[[ -d $D/snap-gitea ]] || { tar -C $D -xzf $F/snap/gitea.tgz && mv $D/gitea $D/snap-gitea-tmp 2>/dev/null; rm -rf $D/snap-gitea; mv $D/snap-gitea-tmp $D/snap-gitea; chown -R gitea:gitea $D/snap-gitea; }
$F/bin/farm.sh stop gitea >/dev/null
rsync -a --delete $D/snap-gitea/ $D/gitea/
$F/bin/farm.sh start gitea >/dev/null
for i in $(seq 100); do curl -sf -o /dev/null http://127.0.0.1:7121/api/healthz && exit 0; sleep 0.2; done
echo "gitea did not come back" >&2; exit 1
