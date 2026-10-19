#!/usr/bin/env bash
# Reset HumHub (people.farm.test) to the seed: reload the MariaDB dump (and the code tree if the pod
# restarted). --snapshot saves the current DB as the seed.
set -euo pipefail
F=/workspace/clone-farm; S=/workspace/action-data-gen/scripts/clones/farm
if [[ "${1:-}" == --snapshot ]]; then
  mysqldump --single-transaction --skip-comments humhub > $F/snap/humhub.sql; exit 0
fi
[[ -f /dev/shm/clone-farm/src/humhub/index.php ]] || bash $S/humhub/install.sh >/dev/null
mysql humhub < $F/snap/humhub.sql
