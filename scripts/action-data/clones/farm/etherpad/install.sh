#!/usr/bin/env bash
# Rebuild Etherpad from scratch in /dev/shm via /opt/clone-farm (natives moved to /workspace). Never /workspace (quota).
set -e
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
export PATH=/opt/node-v24.22.0-linux-x64/bin:$PATH npm_config_manage_package_manager_versions=false
D=/opt/clone-farm/etherpad
if [[ ! -d $D ]]; then mkdir -p $(dirname $D); git clone --depth 1 -b master https://github.com/ether/etherpad-lite.git $D; fi
cd $D && pnpm install --store-dir /dev/shm/clone-farm/.pnpm-store && pnpm run build:etherpad 2>/dev/null || true
# settings.json = the template with our host/port/db/auth.
sed -e 's#"title": "Etherpad",#"title": "Docs",#' -e 's#"ip": "0.0.0.0",#"ip": "127.0.0.1",#' -e 's#"port": 9001,#"port": 7132,#' \
  -e 's#"filename": "var/dirty.db"#"filename": "/dev/shm/clone-farm/etherpad/dirty.db"#' \
  -e 's#^  "defaultPadText" : ".*",#  "defaultPadText" : "",#' -e 's#"${AUTHENTICATION_METHOD:sso}"#"apikey"#' \
  -e 's#"trustProxy": false,#"trustProxy": true,#' -e 's#"loglevel": "INFO",#"loglevel": "WARN",#' \
  settings.json.template > settings.json
# Fixed API key so the reset script and the task module can call the HTTP API.
cp /workspace/clone-farm/etherpad/APIKEY.txt $D/APIKEY.txt 2>/dev/null || true
# Headings (H1-H4) like Google Docs.
bash /workspace/action-data-gen/scripts/clones/farm/data/natives.sh etherpad $D >/dev/null
ESBUILD_BINARY_PATH=$(find /workspace/clone-farm/native/etherpad -name esbuild -type f | head -1) pnpm run install-plugins ep_headings2 || true
# Native files to /workspace (exec allowed; /dev/shm is noexec).
bash /workspace/action-data-gen/scripts/clones/farm/data/natives.sh etherpad /opt/clone-farm/etherpad
