#!/usr/bin/env bash
# Lemmy 0.19.20 (Reddit-like) on forum.farm.test: lemmy_server :7141 + lemmy-ui :7142, shared postgres.
# Binaries come from the official Docker images, pulled without Docker (pull-image.sh); only the server
# binary, sharp's native addon and a lemmy-ui tarball stay on /workspace; the live UI tree is in /opt (-> /dev/shm).
set -euo pipefail
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
F=/workspace/clone-farm; S=/workspace/action-data-gen/scripts/clones/farm
mkdir -p $F/lemmy $F/src/lemmy
if [[ ! -x $F/src/lemmy/lemmy_server ]]; then
  T=/dev/shm/clone-farm/src/lemmy-img; bash $S/lemmy/pull-image.sh dessalines/lemmy 0.19.20 $T
  cp $T/usr/local/bin/lemmy_server $F/src/lemmy/; chmod +x $F/src/lemmy/lemmy_server; rm -rf $T
fi
if [[ ! -f $F/src/lemmy-ui-app.tgz ]]; then
  T=/dev/shm/clone-farm/src/lemmy-ui-img; bash $S/lemmy/pull-image.sh dessalines/lemmy-ui 0.19.20 $T
  mv $T/app $T/lemmy-ui; tar czf $F/src/lemmy-ui-app.tgz -C $T lemmy-ui; rm -rf $T
fi
[[ -f /opt/clone-farm/lemmy-ui/dist/js/server.js ]] || { mkdir -p /opt/clone-farm; tar xzf $F/src/lemmy-ui-app.tgz --no-same-owner -C /opt/clone-farm; }
bash $S/lemmy/exec-overlay.sh /opt/clone-farm/lemmy-ui   # /dev/shm is noexec: sharp's .node goes to /workspace
PW=$(python3 -c "import json;print(json.load(open('$S/accounts.json'))['password'])")
cat > $F/lemmy/lemmy.hjson <<HJ
{
  database: { uri: "postgres://lemmy:lemmyfarm@127.0.0.1:5432/lemmy" }
  hostname: "forum.farm.test"
  bind: "127.0.0.1"
  port: 7141
  tls_enabled: false
  setup: { admin_username: "farmadmin", admin_password: "$PW", site_name: "Threadly" }
}
HJ
if ! su postgres -c "psql -tAc \"select 1 from pg_database where datname='lemmy'\"" | grep -q 1; then
  su postgres -c "psql -c \"create user lemmy with password 'lemmyfarm' superuser\"" || true
  su postgres -c "psql -c 'create database lemmy owner lemmy'"
fi
echo lemmy installed
