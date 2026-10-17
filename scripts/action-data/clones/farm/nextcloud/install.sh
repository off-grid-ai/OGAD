#!/usr/bin/env bash
# One-time Nextcloud install for the clone farm (cloud.farm.test). Code + data in /dev/shm, DB in postgres.
# After this: python3 seed/nextcloud_seed.py, then farm/nextcloud/snapshot.sh.
set -e
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
F=/workspace/clone-farm
W=/dev/shm/clone-farm/nextcloud
ACC=/workspace/action-data-gen/scripts/clones/farm/accounts.json
PASS=$(python3 -c "import json;print(json.load(open('$ACC'))['password'])")
DBPASS=nc-farm-db
mkdir -p $W
if [[ ! -d $W/www ]]; then
  [[ -f $F/src/nextcloud-latest.tar.bz2 ]] || curl -sL -o $F/src/nextcloud-latest.tar.bz2 https://download.nextcloud.com/server/releases/latest.tar.bz2
  (cd $W && tar --no-same-owner -xjf $F/src/nextcloud-latest.tar.bz2 && mv nextcloud www)
fi
psql_() { su postgres -c "psql -v ON_ERROR_STOP=1 -tAc \"$1\""; }
psql_ "select 1 from pg_roles where rolname='nextcloud'" | grep -q 1 || psql_ "create role nextcloud login createdb password '$DBPASS'"
psql_ "drop database if exists nextcloud"
psql_ "create database nextcloud owner nextcloud"
rm -rf $W/data $W/www/config/config.php
redis-cli -n 11 flushdb >/dev/null
cd $W/www
occ() { php -d memory_limit=1G occ "$@"; }
occ maintenance:install --database pgsql --database-name nextcloud --database-host 127.0.0.1 --database-user nextcloud \
  --database-pass "$DBPASS" --admin-user farmadmin --admin-pass "$PASS" --data-dir $W/data
occ config:system:set trusted_domains 0 --value cloud.farm.test
occ config:system:set trusted_domains 1 --value localhost
occ config:system:set overwrite.cli.url --value http://cloud.farm.test
occ config:system:set htaccess.RewriteBase --value /
occ config:system:set memcache.local --value '\OC\Memcache\Redis'
occ config:system:set memcache.distributed --value '\OC\Memcache\Redis'
occ config:system:set memcache.locking --value '\OC\Memcache\Redis'
occ config:system:set redis host --value 127.0.0.1
occ config:system:set redis port --value 6379 --type integer
occ config:system:set redis dbindex --value 11 --type integer
occ config:system:set default_phone_region --value IN
occ config:system:set default_timezone --value Asia/Kolkata
occ config:system:set defaultapp --value files
occ config:system:set skeletondirectory --value ''
occ config:system:set templatedirectory --value ''
occ config:system:set knowledgebaseenabled --value false --type boolean
occ config:system:set auth.bruteforce.protection.enabled --value false --type boolean
occ config:system:set ratelimit.protection.enabled --value false --type boolean
occ config:system:set updatechecker --value false --type boolean
occ config:system:set appstoreenabled --value true --type boolean
occ config:system:set maintenance_window_start --value 1 --type integer
occ config:system:set loglevel --value 3 --type integer
occ config:system:set session_lifetime --value 864000 --type integer
occ config:system:set remember_login_cookie_lifetime --value 8640000 --type integer
occ config:system:set session_keepalive --value true --type boolean
occ config:system:set token_auth_enforced --value false --type boolean
occ background:cron
for a in firstrunwizard dashboard recommendations nextcloud_announcements updatenotification survey_client support \
         weather_status password_policy app_api photos related_resources user_status suspicious_login privacy; do
  occ app:disable $a >/dev/null 2>&1 || true
done
for a in calendar contacts deck notes; do occ app:install $a || occ app:enable $a; done
occ app:enable text
occ config:system:set appstoreenabled --value false --type boolean
occ config:system:set has_internet_connection --value false --type boolean
occ config:app:set files show_hidden --value 0 || true
occ config:app:set core shareapi_allow_share_dialog_user_enumeration --value yes
echo "install done"
