#!/usr/bin/env bash
# Rebuild the Mattermost seed from scratch: empty DB -> migrations -> seed -> template DB mattermost_seed.
set -e
mkdir -p /workspace/clone-farm/snap
F=/workspace/clone-farm
S=/workspace/action-data-gen/scripts/clones
psql() { su postgres -c "psql -q -v ON_ERROR_STOP=1 -c \"$1\""; }
$F/bin/farm.sh stop mattermost
psql "drop database if exists mattermost with (force)"; psql "drop database if exists mattermost_seed with (force)"
psql "create database mattermost owner mmuser"
rm -rf /dev/shm/clone-farm/mattermost/data
$F/bin/farm.sh start mattermost
for i in $(seq 90); do curl -sf http://127.0.0.1:7120/api/v4/system/ping >/dev/null && break; sleep 1; done
python3 $S/seed/mattermost_seed.py
$F/bin/farm.sh stop mattermost
psql "create database mattermost_seed template mattermost owner mmuser"
su postgres -c "pg_dump --no-owner -d mattermost_seed" | gzip > $F/snap/mattermost.sql.gz
$F/bin/farm.sh start mattermost
for i in $(seq 90); do curl -sf http://127.0.0.1:7120/api/v4/system/ping >/dev/null && break; sleep 1; done
echo seeded
