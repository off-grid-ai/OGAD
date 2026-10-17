#!/usr/bin/env bash
# One-time install of the wiki clone: BookStack on a private MariaDB (port 7152, datadir on tmpfs).
# Code in /dev/shm/clone-farm/wiki-www. Then: php seed/wiki_seed.php, then reset.sh --save.
set -e
F=/workspace/clone-farm; L=/dev/shm/clone-farm; W=$L/wiki-www
M=/workspace/action-data-gen/scripts/clones
PASS=$(python3 -c "import json;print(json.load(open('$M/farm/accounts.json'))['password'])")
V=v26.09.1
if [[ ! -d $L/wiki-db/mysql ]]; then
  mkdir -p $L/wiki-db && chown mysql:mysql $L/wiki-db
  mariadb-install-db --no-defaults --user=mysql --datadir=$L/wiki-db --auth-root-authentication-method=socket >/dev/null
fi
bash $F/bin/farm.sh sync >/dev/null || true
bash $F/bin/farm.sh start wiki-db
for i in $(seq 1 100); do mysqladmin --socket=/run/mysqld/wiki.sock ping >/dev/null 2>&1 && break; sleep 0.2; done
mysql --socket=/run/mysqld/wiki.sock -e "CREATE DATABASE IF NOT EXISTS bookstack; CREATE USER IF NOT EXISTS 'bookstack'@'localhost' IDENTIFIED BY 'bookstack'; GRANT ALL ON bookstack.* TO 'bookstack'@'localhost'; FLUSH PRIVILEGES;"
if [[ ! -f $W/artisan ]]; then
  mkdir -p $W && curl -sSL https://github.com/BookStackApp/BookStack/archive/refs/tags/$V.tar.gz | tar -xz --no-same-owner -C $W --strip-components=1
fi
cd $W
[[ -d vendor/laravel ]] || COMPOSER_ALLOW_SUPERUSER=1 composer install --no-dev --no-interaction --no-progress --optimize-autoloader
if [[ ! -f .env ]]; then
  cp .env.example .env
  sed -i "s#^APP_URL=.*#APP_URL=http://wiki.farm.test#; s#^DB_HOST=.*#DB_HOST=localhost#; s#^DB_DATABASE=.*#DB_DATABASE=bookstack#; s#^DB_USERNAME=.*#DB_USERNAME=bookstack#; s#^DB_PASSWORD=.*#DB_PASSWORD=bookstack#" .env
  printf 'DB_SOCKET=/run/mysqld/wiki.sock\nMAIL_DRIVER=log\nAPP_TIMEZONE=Asia/Kolkata\nALLOW_ROBOTS=false\nAVATAR_URL=false\nSESSION_LIFETIME=10080\n' >> .env
  php artisan key:generate --force
fi
php artisan migrate --force
printf '%s\n' 'Seed: WIKI_PASS=... php seed/wiki_seed.php; then bash farm/wiki/reset.sh --save' >/dev/null
