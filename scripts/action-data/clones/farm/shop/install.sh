#!/usr/bin/env bash
# One-time install of the shop clone: WordPress + WooCommerce + Storefront on a private MariaDB (port 7151).
# Then: wp eval-file seed/shop_seed.php, and dbreset.sh shop --save + www snapshot.
set -e
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
F=/workspace/clone-farm; L=/dev/shm/clone-farm; W=$L/shop-www
M=/workspace/action-data-gen/scripts/clones
PASS=$(python3 -c "import json;print(json.load(open('$M/farm/accounts.json'))['password'])")
mkdir -p $L $F/bin
[[ -x $F/bin/wp ]] || { curl -sSLo $F/bin/wp https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar; chmod +x $F/bin/wp; }
WP="php -d memory_limit=2048M $F/bin/wp --allow-root --path=$W"
if [[ ! -d $L/shop-db/mysql ]]; then
  mkdir -p $L/shop-db && chown mysql:mysql $L/shop-db
  mariadb-install-db --no-defaults --user=mysql --datadir=$L/shop-db --auth-root-authentication-method=socket >/dev/null
fi
bash $F/bin/farm.sh sync >/dev/null || true
bash $F/bin/farm.sh start shop-db
for i in $(seq 1 100); do mysqladmin --socket=/run/mysqld/shop.sock ping >/dev/null 2>&1 && break; sleep 0.2; done
mysql --socket=/run/mysqld/shop.sock -e "CREATE DATABASE IF NOT EXISTS shop; CREATE USER IF NOT EXISTS 'shop'@'localhost' IDENTIFIED BY 'shop'; GRANT ALL ON shop.* TO 'shop'@'localhost'; FLUSH PRIVILEGES;"
mkdir -p $W
[[ -f $W/wp-load.php ]] || $WP core download --locale=en_US
[[ -f $W/wp-config.php ]] || $WP config create --dbname=shop --dbuser=shop --dbpass=shop --dbhost=localhost:/run/mysqld/shop.sock --skip-check
$WP config set WP_HOME http://shop.farm.test; $WP config set WP_SITEURL http://shop.farm.test
$WP config set DISABLE_WP_CRON true --raw; $WP config set AUTOMATIC_UPDATER_DISABLED true --raw; $WP config set WP_AUTO_UPDATE_CORE false --raw
$WP config delete WP_HTTP_BLOCK_EXTERNAL 2>/dev/null || true
$WP core is-installed || $WP core install --url=http://shop.farm.test --title="Bazaar" --admin_user=farmadmin --admin_password="$PASS" --admin_email=farmadmin@farm.test --skip-email
$WP plugin install woocommerce yith-woocommerce-wishlist --activate
$WP theme install storefront --activate
$WP plugin delete akismet hello 2>/dev/null || true
$WP config set WP_HTTP_BLOCK_EXTERNAL true --raw
