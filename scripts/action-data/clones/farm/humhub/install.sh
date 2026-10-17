#!/usr/bin/env bash
# HumHub 1.18 (LinkedIn/Facebook-like intranet) on people.farm.test. HELD-OUT TEST APP.
# Code + uploads live in /dev/shm (many small files; lost on pod restart -> this script rebuilds).
# DB: MariaDB "humhub". Config written by the CLI installer, kept in /workspace/clone-farm/humhub/config.
set -euo pipefail
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
F=/workspace/clone-farm; S=/workspace/action-data-gen/scripts/clones/farm; H=/dev/shm/clone-farm/src/humhub
[[ -f $F/src/humhub.tgz ]] || curl -sL -o $F/src/humhub.tgz https://download.humhub.com/downloads/install/humhub-1.18.0.tar.gz
if [[ ! -f $H/index.php ]]; then mkdir -p $H && tar -xzf $F/src/humhub.tgz --no-same-owner -C $H --strip-components=1; fi
mkdir -p $F/humhub/config
PW=$(python3 -c "import json;print(json.load(open('$S/accounts.json'))['password'])")
if [[ -f $F/humhub/config/dynamic.php ]]; then
  cp $F/humhub/config/*.php $H/protected/config/
else
  mysql -e "create database if not exists humhub character set utf8mb4 collate utf8mb4_unicode_ci; create user if not exists 'humhub'@'localhost' identified by 'humhubfarm'; grant all on humhub.* to 'humhub'@'localhost';"
  cd $H/protected
  cp $S/humhub/console.php config/console.php
  php yii installer/write-db-config localhost humhub humhub humhubfarm
  php yii installer/install-db
  php yii installer/write-site-config "Linkup" "admin@people.farm.test"
  php yii installer/set-base-url http://people.farm.test
  php yii installer/create-admin-account farmadmin farmadmin@farm.test "$PW"
  cp $S/humhub/common.php $H/protected/config/common.php
  cp $H/protected/config/dynamic.php $H/protected/config/common.php $H/protected/config/console.php $F/humhub/config/
fi
echo humhub installed
