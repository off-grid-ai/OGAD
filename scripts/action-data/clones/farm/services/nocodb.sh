#!/usr/bin/env bash
# NocoDB for tables.farm.test on 127.0.0.1:7134 (meta + data in postgres db farm_nocodb).
export PATH=/opt/node-v24.22.0-linux-x64/bin:$PATH
D=/opt/clone-farm/nocodb
[[ -d $D/node_modules/nocodb ]] || bash /workspace/action-data-gen/scripts/clones/farm/nocodb/install.sh
cd $D
export NC_DB="pg://127.0.0.1:5432?u=nocodb&p=nocodb&d=farm_nocodb" PORT=7134 NC_PUBLIC_URL=http://tables.farm.test NC_DISABLE_TELE=true NC_DISABLE_CACHE=true NC_AUTH_JWT_SECRET=farm-nocodb-secret-not-real NC_INVITE_ONLY_SIGNUP=true NC_ALLOW_LOCAL_HOOKS=false
exec node index.js
