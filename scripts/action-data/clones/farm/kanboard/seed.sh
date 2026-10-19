#!/usr/bin/env bash
# Rebuild the Kanboard seed: fresh sqlite DB -> JSON-RPC seed -> back-dated times -> snapshot
# (/workspace/clone-farm/snap/kanboard.sqlite, copied to /dev/shm/clone-farm/snap-kanboard.sqlite for fast resets).
set -e
F=/workspace/clone-farm; S=/workspace/action-data-gen/scripts/clones; D=/dev/shm/clone-farm
bash $S/farm/kanboard/install.sh
rm -f $D/kanboard/db.sqlite*
curl -sf -o /dev/null "http://board.farm.test/?controller=AuthController&action=login"   # creates the schema + default admin
TOKEN=$(sqlite3 $D/kanboard/db.sqlite "select value from settings where option='api_token'")
python3 $S/seed/kanboard_seed.py "$TOKEN"
sqlite3 $D/kanboard/db.sqlite <<'SQL'
update tasks set date_creation = date_creation - (abs(random()) % (40*86400)) - 86400;
update tasks set date_modification = date_creation + (abs(random()) % (3*86400)), date_moved = date_creation + (abs(random()) % (3*86400));
update tasks set date_completed = date_modification where is_active = 0;
update comments set date_creation = (select t.date_creation from tasks t where t.id = comments.task_id) + 3600 + (abs(random()) % (5*86400)), date_modification = 0;
update comments set date_modification = date_creation;
update subtasks set status = status;
delete from sessions;
delete from last_logins;
SQL
mkdir -p $F/snap; cp $D/kanboard/db.sqlite $F/snap/kanboard.sqlite; cp $D/kanboard/db.sqlite $D/snap-kanboard.sqlite
echo seeded
