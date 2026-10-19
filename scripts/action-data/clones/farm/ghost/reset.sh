#!/usr/bin/env bash
# Reset Ghost to the seed in place (<1 s): copy every table back from the seed DB inside one transaction,
# while Ghost keeps running. Sessions and brute-force counters stay, so a signed-in browser stays signed in.
# If the live DB is missing (pod restart), copy the whole seed and (re)start Ghost.
set -e
LIVE=/dev/shm/clone-farm/ghost/ghost.db
SEED=/dev/shm/clone-farm/ghost/seed.db
mkdir -p /dev/shm/clone-farm/ghost
[[ -f $SEED ]] || cp /workspace/clone-farm/snap/ghost/ghost.db $SEED
if [[ ! -f $LIVE ]]; then cp $SEED $LIVE; bash /workspace/clone-farm/bin/farm.sh restart ghost >/dev/null; sleep 12; exit 0; fi
SQL=$(sqlite3 $SEED "select name from sqlite_master where type='table' and name not in ('sessions','brute','migrations','migrations_lock') and name not like 'sqlite_%'" |
  awk '{ printf "delete from main.\"%s\"; insert into main.\"%s\" select * from seed.\"%s\";\n", $1, $1, $1 }')
sqlite3 $LIVE <<SQL
.timeout 10000
pragma foreign_keys=off;
attach '$SEED' as seed;
begin immediate;
$SQL
commit;
SQL
