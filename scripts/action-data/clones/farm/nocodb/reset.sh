#!/usr/bin/env bash
# Reset NocoDB to the seed: recreate farm_nocodb from the template farm_nocodb_seed (meta + data, ~1 s) while NocoDB
# keeps running (NC_DISABLE_CACHE=true; its pool reconnects). If the template is missing (fresh container), restore it
# from /workspace/clone-farm/snap/db (farm/restore-dbs.sh) first.
set -e
P() { su postgres -c "psql -qAt -c \"$1\""; }
[[ "$(P "select 1 from pg_database where datname='farm_nocodb_seed'")" == 1 ]] || bash /workspace/action-data-gen/scripts/clones/farm/restore-dbs.sh >/dev/null
P "update pg_database set datallowconn=false where datname='farm_nocodb'" || true
P "select pg_terminate_backend(pid) from pg_stat_activity where datname='farm_nocodb'" >/dev/null
P "drop database if exists farm_nocodb"
P "create database farm_nocodb owner nocodb template farm_nocodb_seed"
# Let the pool notice the dropped connections before the next request.
curl -s -o /dev/null --max-time 10 http://127.0.0.1:7134/api/v1/health || true
