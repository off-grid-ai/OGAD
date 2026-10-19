#!/usr/bin/env bash
# Reset Nextcloud (cloud.farm.test) to the seed: DB from the template DB, data dir from the /dev/shm seed copy, cache flushed. ~1-2 s.
# After a pod restart (empty /dev/shm, no template DB) it rebuilds everything from /workspace/clone-farm/snap.
set -euo pipefail
F=/workspace/clone-farm; W=/dev/shm/clone-farm/nextcloud
Q() { su postgres -c "psql -v ON_ERROR_STOP=1 -tAc \"$1\""; }
[[ -d $W/www ]] || { mkdir -p $W && tar --no-same-owner -I zstd -xf $F/snap/nextcloud-www.tar.zst -C $W; }
[[ -d $W/seed-data ]] || { mkdir -p $W/seed-data && tar --no-same-owner -xf $F/snap/nextcloud-data.tar -C $W/seed-data; }
if [[ -z "$(Q "select 1 from pg_database where datname='nextcloud_seed'")" ]]; then
  Q "select 1 from pg_roles where rolname='nextcloud'" | grep -q 1 || Q "create role nextcloud login createdb password 'nc-farm-db'"
  Q "create database nextcloud_seed owner nextcloud"
  su postgres -c "pg_restore -d nextcloud_seed --no-owner --role=nextcloud" < $F/snap/nextcloud.pgdump
fi
Q "drop database if exists nextcloud with (force)" >/dev/null
Q "create database nextcloud template nextcloud_seed owner nextcloud" >/dev/null
rsync -a --delete $W/seed-data/ $W/data/
redis-cli -n 11 flushdb >/dev/null
