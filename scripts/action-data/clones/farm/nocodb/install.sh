#!/usr/bin/env bash
# Rebuild NocoDB (npm package, last DOM-rendered grid release; 0.26x+ draws the grid on a canvas) in /dev/shm via /opt/clone-farm.
# /dev/shm is noexec and /workspace has a per-file quota, so code lives in /opt/clone-farm; data in postgres.
set -e
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
export PATH=/opt/node-v24.22.0-linux-x64/bin:$PATH
D=/opt/clone-farm/nocodb
mkdir -p $D && cd $D
[[ -f package.json ]] || echo '{"name":"farm-nocodb","private":true}' > package.json
npm install --no-audit --no-fund nocodb@0.258.11
cat > index.js <<'JS'
// NocoDB entry: express app on NC_PORT.
const express = require('express')
;(async () => {
  const app = express()
  const server = app.listen(process.env.PORT || 7134, '127.0.0.1', () => console.log('nocodb up'))
  app.use(await require('nocodb').Noco.init({}, server, app))
})()
JS
# postgres DBs: farm_nocodb (meta + data). The seed snapshot is the template farm_nocodb_seed.
su postgres -c "psql -tc \"select 1 from pg_roles where rolname='nocodb'\"" | grep -q 1 || su postgres -c "psql -c \"create role nocodb login password 'nocodb' createdb\""
# Native files to /workspace (exec allowed; /dev/shm is noexec).
bash /workspace/action-data-gen/scripts/clones/farm/data/natives.sh nocodb /opt/clone-farm/nocodb
