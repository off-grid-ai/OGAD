#!/usr/bin/env bash
# Rebuild the Gitea seed from scratch: empty data dir -> admin -> seed -> snapshot
# (/workspace/clone-farm/snap/gitea.tgz, small; unpacked to /dev/shm/clone-farm/snap-gitea for fast resets).
set -e
F=/workspace/clone-farm; S=/workspace/action-data-gen/scripts/clones; D=/dev/shm/clone-farm
G=/workspace/clone-farm/bin-native/gitea
PW=$(python3 -c "import json;print(json.load(open('$S/farm/accounts.json'))['password'])")
$F/bin/farm.sh stop gitea
rm -rf $D/gitea; mkdir -p $D/gitea
$F/bin/farm.sh start gitea
for i in $(seq 60); do curl -sf http://127.0.0.1:7121/api/healthz >/dev/null && break; sleep 1; done
setpriv --reuid=gitea --regid=gitea --init-groups env HOME=$D/gitea/home GITEA_WORK_DIR=$D/gitea $G admin user create --config $D/gitea-etc/app.ini \
  --admin --username farmadmin --password "$PW" --email farmadmin@farm.test --must-change-password=false >/dev/null
python3 $S/seed/gitea_seed.py
$F/bin/farm.sh stop gitea
# Spread issue, comment and PR times over the last 60 days (the API stamps them now).
sqlite3 $D/gitea/data/gitea.db <<'SQL'
update issue set created_unix = created_unix - (abs(random()) % (60*86400)) - 86400;
update issue set deadline_unix = 0;
-- keep the timeline order: each event 2-3 h after the previous one
update comment set created_unix = (select i.created_unix from issue i where i.id = comment.issue_id) + 1800
  + (select count(*) from comment c2 where c2.issue_id = comment.issue_id and c2.id < comment.id) * 7200 + abs(random()) % 3600;
update comment set updated_unix = created_unix;
update issue set updated_unix = max(created_unix, coalesce((select max(created_unix) from comment c where c.issue_id = issue.id), 0));
update issue set closed_unix = updated_unix where is_closed = 1;
update repository set updated_unix = (select max(updated_unix) from issue i where i.repo_id = repository.id) where exists (select 1 from issue i where i.repo_id = repository.id);
SQL
rm -rf $D/gitea/sessions/* $D/gitea/log/* 2>/dev/null || true
mkdir -p $F/snap; tar -C $D -czf $F/snap/gitea.tgz gitea
rm -rf $D/snap-gitea; cp -a $D/gitea $D/snap-gitea
$F/bin/farm.sh start gitea
for i in $(seq 60); do curl -sf http://127.0.0.1:7121/api/healthz >/dev/null && break; sleep 1; done
echo seeded
