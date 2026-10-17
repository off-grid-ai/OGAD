#!/usr/bin/env bash
# Restore a private MariaDB (shop|wiki) to its seed snapshot. ~2-4 s.
#   dbreset.sh <name>          restore from snap
#   dbreset.sh <name> --save   stop, save current datadir as the seed snapshot, start
set -e
N=$1; F=/workspace/clone-farm; L=/dev/shm/clone-farm
SNAPT=$F/snap/$N-db.tar; FAST=$L/snap-$N-db
waitup() { for i in $(seq 1 100); do mysqladmin --socket=/run/mysqld/$N.sock ping >/dev/null 2>&1 && return 0; sleep 0.1; done; echo "$N-db did not start" >&2; return 1; }
bash $F/bin/farm.sh stop $N-db >/dev/null
if [[ "${2:-}" == "--save" ]]; then
  rm -rf $FAST; cp -a $L/$N-db $FAST
  tar -C $L -cf $SNAPT.tmp $N-db && mv $SNAPT.tmp $SNAPT
else
  if [[ ! -d $FAST ]]; then mkdir -p $L/tmp-$N && tar -C $L/tmp-$N -xf $SNAPT && rm -rf $FAST && mv $L/tmp-$N/$N-db $FAST && rm -rf $L/tmp-$N; fi
  rsync -a --delete $FAST/ $L/$N-db/
  rm -f $L/$N-db/*.pid
fi
bash $F/bin/farm.sh start $N-db >/dev/null
waitup
