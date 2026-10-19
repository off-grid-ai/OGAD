#!/usr/bin/env bash
# One-time install of the tasks clone: Planka v2 (Trello-like, node + postgres) at tasks.farm.test -> 127.0.0.1:7153.
# Code lives on tmpfs (/dev/shm/clone-farm/opt/planka, 165 MB). /dev/shm is noexec: native modules are replaced by shims (shim-native.sh).
set -e
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
F=/workspace/clone-farm; L=/dev/shm/clone-farm; S=/dev/shm/clone-farm/opt/planka
M=/workspace/action-data-gen/scripts/clones
PASS=$(python3 -c "import json;print(json.load(open('$M/farm/accounts.json'))['password'])")
if [[ ! -f $S/app.js ]]; then
  mkdir -p /dev/shm/clone-farm/opt && cd /dev/shm/clone-farm/opt && rm -rf planka-dl && mkdir planka-dl && cd planka-dl
  curl -sSLo p.zip https://github.com/plankanban/planka/releases/download/v2.2.1/planka-prebuild.zip && unzip -q p.zip
  mv planka $S && cd .. && rm -rf planka-dl
fi
cd $S
[[ -d node_modules/sails ]] || npm ci --omit=dev --no-audit --no-fund --ignore-scripts
node node_modules/patch-package/index.js >/dev/null
bash /workspace/action-data-gen/scripts/clones/farm/tasks/shim-native.sh $S
su postgres -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='planka'\"" | grep -q 1 || su postgres -c "psql -c \"CREATE ROLE planka LOGIN SUPERUSER PASSWORD 'planka'\""
su postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='planka'\"" | grep -q 1 || su postgres -c "createdb -O planka planka"
cat > .env <<ENV
BASE_URL=http://tasks.farm.test
DATABASE_URL=postgresql://planka:planka@127.0.0.1:5432/planka
SECRET_KEY=farm-planka-secret-key-not-a-real-secret
PORT=7153
DEFAULT_ADMIN_EMAIL=farmadmin@farm.test
DEFAULT_ADMIN_PASSWORD=$PASS
DEFAULT_ADMIN_NAME=Farm Admin
DEFAULT_ADMIN_USERNAME=farmadmin
TRUST_PROXY=true
ENV
npm run db:init
