#!/usr/bin/env bash
# Freeze the current Nextcloud state as the seed: template DB + data copy in /dev/shm, archives in /workspace/clone-farm/snap.
set -euo pipefail
F=/workspace/clone-farm; W=/dev/shm/clone-farm/nextcloud
Q() { su postgres -c "psql -v ON_ERROR_STOP=1 -tAc \"$1\""; }
cd $W/www && php occ files:scan --all -q || true
Q "drop database if exists nextcloud_seed"
Q "create database nextcloud_seed template nextcloud owner nextcloud" || { Q "select pg_terminate_backend(pid) from pg_stat_activity where datname='nextcloud'" >/dev/null; Q "create database nextcloud_seed template nextcloud owner nextcloud"; }
su postgres -c "pg_dump -Fc nextcloud_seed" > $F/snap/nextcloud.pgdump
rm -rf $W/seed-data && cp -a $W/data $W/seed-data
rm -f $W/seed-data/nextcloud.log
tar -C $W/seed-data -cf $F/snap/nextcloud-data.tar .
rm -f $F/snap/nextcloud-www.tar; tar -C $W -I "zstd -T8 -10" -cf $F/snap/nextcloud-www.tar.zst www
ls -la $F/snap/nextcloud*
