#!/usr/bin/env bash
# Reset the tasks clone (Planka) to the seed: recreate DB "planka" from template "planka_seed".
#   reset.sh          restore (Planka keeps running; its pool reconnects)
#   reset.sh --save   make the current DB the seed (template + gz dump in /workspace/clone-farm/snap)
set -e
F=/workspace/clone-farm
P="su postgres -c"
if [[ "${1:-}" == "--save" ]]; then
  $P "psql -q -c \"DROP DATABASE IF EXISTS planka_seed WITH (FORCE)\" -c \"CREATE DATABASE planka_seed TEMPLATE planka WITH (FORCE)\"" 2>/dev/null || \
  $P "psql -q -c \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='planka'\" -c \"DROP DATABASE IF EXISTS planka_seed\" -c \"CREATE DATABASE planka_seed TEMPLATE planka\""
  $P "pg_dump -Fc planka_seed" > $F/snap/planka.dump
  exit 0
fi
if ! $P "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='planka_seed'\"" | grep -q 1; then
  $P "createdb -O planka planka_seed" && $P "pg_restore -d planka_seed --no-owner --role=planka $F/snap/planka.dump"
fi
$P "psql -q -c \"DROP DATABASE IF EXISTS planka WITH (FORCE)\" -c \"CREATE DATABASE planka TEMPLATE planka_seed OWNER planka\""
