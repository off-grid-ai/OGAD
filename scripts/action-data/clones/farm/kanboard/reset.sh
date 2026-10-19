#!/usr/bin/env bash
# Reset Kanboard to the seed: copy the seed sqlite back (php-fpm opens it per request). ~50 ms.
set -e
D=/dev/shm/clone-farm
[[ -f $D/snap-kanboard.sqlite ]] || cp /workspace/clone-farm/snap/kanboard.sqlite $D/snap-kanboard.sqlite
[[ -f $D/src/kanboard/index.php ]] || bash /workspace/action-data-gen/scripts/clones/farm/kanboard/install.sh
cp $D/snap-kanboard.sqlite $D/kanboard/db.sqlite.tmp && mv $D/kanboard/db.sqlite.tmp $D/kanboard/db.sqlite
rm -f $D/kanboard/db.sqlite-wal $D/kanboard/db.sqlite-shm
