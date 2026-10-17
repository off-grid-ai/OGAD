#!/usr/bin/env bash
# Reset Akkoma to the seed: stop the server, recreate DB "akkoma" from template "akkoma_seed", start. ~3 s.
#   reset.sh            reset
#   reset.sh --snapshot make the current DB the seed (template + dump on /workspace)
set -euo pipefail
F=/workspace/clone-farm
psql() { su postgres -c "psql -q -v ON_ERROR_STOP=1 -c \"$1\"" >/dev/null; }
if [[ "${1:-}" == --snapshot ]]; then
  $F/bin/farm.sh stop akkoma >/dev/null
  psql "drop database if exists akkoma_seed with (force)"; psql "create database akkoma_seed template akkoma owner akkoma"
  su postgres -c "pg_dump -Fc akkoma_seed" > $F/snap/akkoma.dump
  $F/bin/farm.sh start akkoma >/dev/null
else
  if ! su postgres -c "psql -tAc \"select 1 from pg_database where datname='akkoma_seed'\"" | grep -q 1; then
    psql "create database akkoma_seed owner akkoma"; su postgres -c "pg_restore -d akkoma_seed --no-owner --role=akkoma" < $F/snap/akkoma.dump
  fi
  $F/bin/farm.sh stop akkoma >/dev/null
  psql "drop database if exists akkoma with (force)"; psql "create database akkoma template akkoma_seed owner akkoma"
  $F/bin/farm.sh start akkoma >/dev/null
fi
for i in $(seq 1 300); do curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7140/api/v1/instance | grep -q 200 && exit 0; sleep 0.2; done
echo "akkoma did not come back" >&2; exit 1
