#!/usr/bin/env bash
# Reset Lemmy to the seed: stop the server, recreate DB "lemmy" from template "lemmy_seed", start. ~3 s.
#   reset.sh            reset
#   reset.sh --snapshot make the current DB the seed (template + dump on /workspace)
set -euo pipefail
F=/workspace/clone-farm
psql() { su postgres -c "psql -q -v ON_ERROR_STOP=1 -c \"$1\"" >/dev/null; }
if [[ "${1:-}" == --snapshot ]]; then
  $F/bin/farm.sh stop lemmy >/dev/null
  psql "drop database if exists lemmy_seed with (force)"; psql "create database lemmy_seed template lemmy owner lemmy"
  su postgres -c "pg_dump -Fc lemmy_seed" > $F/snap/lemmy.dump
  $F/bin/farm.sh start lemmy >/dev/null
else
  if ! su postgres -c "psql -tAc \"select 1 from pg_database where datname='lemmy_seed'\"" | grep -q 1; then
    psql "create database lemmy_seed owner lemmy"; su postgres -c "pg_restore -d lemmy_seed --no-owner --role=lemmy" < $F/snap/lemmy.dump
  fi
  $F/bin/farm.sh stop lemmy >/dev/null
  psql "drop database if exists lemmy with (force)"; psql "create database lemmy template lemmy_seed owner lemmy"
  $F/bin/farm.sh start lemmy >/dev/null
fi
for i in $(seq 1 300); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7141/api/v3/site | grep -q 200 && exit 0; sleep 0.2; done
echo "lemmy did not come back" >&2; exit 1
