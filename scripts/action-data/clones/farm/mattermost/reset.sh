#!/usr/bin/env bash
# Reset Mattermost to the seed: recreate the DB from the template mattermost_seed, then clear the server caches. ~0.3 s.
# If the template is missing (fresh postgres), it is rebuilt from /workspace/clone-farm/snap/mattermost.sql.gz.
set -e
F=/workspace/clone-farm
q() { su postgres -c "psql -q -v ON_ERROR_STOP=1 -c \"$1\""; }
if ! su postgres -c "psql -tAc \"select 1 from pg_database where datname='mattermost_seed'\"" | grep -q 1; then
  q "create database mattermost_seed owner mmuser"
  gunzip -c $F/snap/mattermost.sql.gz | PGPASSWORD=farm-mm-db psql -q -h 127.0.0.1 -U mmuser -d mattermost_seed >/dev/null
fi
q "drop database if exists mattermost with (force)"
q "create database mattermost template mattermost_seed owner mmuser"
curl -sf -X POST -H "Authorization: Bearer $(cat $F/mattermost/admin.token)" http://127.0.0.1:7120/api/v4/caches/invalidate >/dev/null
