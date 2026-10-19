#!/usr/bin/env bash
# Rebuild the clone farm after a pod restart (/dev/shm wiped; /workspace and the root disk kept),
# start every app, reset each to its seed, and resume the capture runs where they stopped.
#   bash /workspace/clone-farm/restore-all.sh            everything
#   bash /workspace/clone-farm/restore-all.sh --no-capture   apps only
# Per-app logs: /workspace/clone-farm/logs/restore/<app>.log. Safe to run again.
set -u
# Works from /workspace alone: a fresh container disk gets packages from bootstrap-system.sh and databases
# from snap/db (refresh those with snapshot-dbs.sh after any re-seed).
F=/workspace/clone-farm; S=/workspace/action-data-gen/scripts/clones/farm; L=$F/logs/restore
mkdir -p $L /dev/shm/clone-farm/opt /run/php
[[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
# Build caches were symlinked into /dev/shm: recreate their targets.
mkdir -p /dev/shm/clone-farm/cache/_root_.npm /dev/shm/clone-farm/cache/_root_.cache/{pnpm,node-gyp,pip} /dev/shm/clone-farm/cache/_root_.local_share_pnpm
grep -q 'mail.farm.test' /etc/hosts || echo "127.0.0.1 mail.farm.test webmail.farm.test cloud.farm.test sheets.farm.test docs.farm.test chat.farm.test git.farm.test board.farm.test tables.farm.test blog.farm.test social.farm.test forum.farm.test people.farm.test shop.farm.test tasks.farm.test wiki.farm.test music.farm.test video.farm.test" >> /etc/hosts
id vmail >/dev/null 2>&1 || { groupadd -g 5000 vmail; useradd -u 5000 -g 5000 -M -s /usr/sbin/nologin vmail; }

# Old pid files point at dead (or reused) pids.
rm -f $F/run/*.pid
cp $S/farm.sh $F/bin/farm.sh
cp $S/services/*.sh $F/services/; cp $S/nginx/sites/*.conf $F/nginx/sites/
FARM=$F/bin/farm.sh
log() { echo "[$(date -u +%T)] $*"; }

log "system layer (packages, postfix, users; no-op when present)"
bash $S/bootstrap-system.sh >> $L/system.log 2>&1 || log "bootstrap failed: see $L/system.log"
log "base services"
$FARM start postgres mariadb redis php postfix nginx
for i in $(seq 60); do su postgres -c "psql -tAc 'select 1'" >/dev/null 2>&1 && mysql -e 'select 1' >/dev/null 2>&1 && break; sleep 1; done
log "databases (recreate missing ones from /workspace)"
bash $S/restore-dbs.sh >> $L/dbs.log 2>&1 || log "restore-dbs failed: see $L/dbs.log"

# app: install (rebuild /dev/shm tree; skipped where reset does it), services, reset.
step() { # step <app> <install|-> <services...> -- reset command
  local app=$1 inst=$2; shift 2
  local svcs=(); while [[ $1 != -- ]]; do svcs+=("$1"); shift; done; shift
  {
    log "== $app"
    [[ $inst != - ]] && { bash "$inst" || log "install failed ($?)"; }
    [[ ${#svcs[@]} -gt 0 ]] && $FARM start "${svcs[@]}"
    sleep 3
    "$@" || log "reset failed ($?)"
  } >> $L/$app.log 2>&1
  log "$app: $(tail -n 1 $L/$app.log)"
}
step mail       $S/mail/install.sh       dovecot     -- bash -c "bash $S/mail/reset.sh && mkdir -p /dev/shm/clone-farm/roundcube && cp $F/snap/roundcube.db /dev/shm/clone-farm/roundcube/rc.db"
step kanboard   $S/kanboard/install.sh               -- bash $S/kanboard/reset.sh
step gitea      $S/gitea/install.sh      gitea       -- bash $S/gitea/reset.sh
step mattermost $S/mattermost/install.sh mattermost  -- bash $S/mattermost/reset.sh
step nextcloud  -                                    -- bash $S/nextcloud/reset.sh
step shop       -                        shop-db     -- bash $S/shop/reset.sh
step wiki       -                        wiki-db     -- bash $S/wiki/reset.sh
step tasks      $S/tasks/install.sh      tasks       -- bash $S/tasks/reset.sh
step ethercalc  $S/ethercalc/install.sh  ethercalc   -- bash $S/ethercalc/reset.sh
step etherpad   $S/etherpad/install.sh   etherpad    -- python3 $S/etherpad/reset.py
step ghost      $S/ghost/install.sh      ghost       -- bash $S/ghost/reset.sh
step nocodb     $S/nocodb/install.sh     nocodb      -- bash $S/nocodb/reset.sh
step akkoma     $S/akkoma/install.sh     akkoma      -- bash $S/akkoma/reset.sh
step lemmy      $S/lemmy/install.sh      lemmy lemmy-ui -- bash $S/lemmy/reset.sh
step humhub     $S/humhub/install.sh                 -- bash $S/humhub/reset.sh
$FARM start
log "hosts:"
for h in mail webmail cloud sheets docs chat git board tables blog social forum people shop tasks wiki; do printf '  %-8s %s\n' $h "$(curl -s -o /dev/null -m 20 -w '%{http_code}' http://$h.farm.test/)"; done

[[ "${1:-}" == --no-capture ]] && exit 0
# Resume each capture: same output dir (rows append), the episodes still missing, a new seed suffix
# so row ids never repeat. Held-out apps keep writing only to clones-test-*.
cd /workspace/action-data-gen/scripts
resume() { # resume <app> <target episodes> <out> <cdp> <old seed>
  local app=$1 target=$2 out=$3 cdp=$4 seed=$5
  local done=0; [[ -f $out/episodes-w0.jsonl ]] && done=$(wc -l < $out/episodes-w0.jsonl)
  local left=$((target - done)); [[ $left -le 0 ]] && { log "capture $app: complete ($done)"; return; }
  local n=2; while grep -q ":$seed-$n:" $out/episodes-w0.jsonl 2>/dev/null; do n=$((n + 1)); done
  setsid nohup bash -c "nice -n 10 xvfb-run -a node clones/clone-capture.mjs --app $app --episodes $left --seed $seed-$n --out $out --cdp $cdp" >> $F/logs/capture-$app.log 2>&1 < /dev/null &
  echo $! > $F/run/capture-$app.pid
  log "capture $app: resumed, $left episodes left (seed $seed-$n)"
}
D=/workspace/action-data
resume roundcube  600 $D/clones-roundcube        9700 r1
resume snappymail 300 $D/clones-test-snappymail  9701 t1
resume nextcloud  600 $D/clones-nextcloud        9710 c1
resume mattermost 1100 $D/clones-mattermost       9720 c1
resume gitea      600 $D/clones-gitea            9721 c1
resume kanboard   400 $D/clones-test-kanboard    9722 c1
resume ethercalc  500 $D/clones-ethercalc        9730 c1
resume ghost      500 $D/clones-ghost            9733 c1
resume akkoma     600 $D/clones-akkoma           9740 c1
resume lemmy      600 $D/clones-lemmy            9741 c1
resume humhub     400 $D/clones-test-humhub      9742 c1
resume woo        500 $D/clones-woo              9750 c1
resume planka     500 $D/clones-planka           9751 c1
resume bookstack  500 $D/clones-bookstack        9752 c1
for extra in etherpad nocodb; do [[ -d $D/clones-$extra ]] && resume $extra 500 $D/clones-$extra $([[ $extra == etherpad ]] && echo 9731 || echo 9732) c1; done
log "done"
