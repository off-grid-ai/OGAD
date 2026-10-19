#!/usr/bin/env bash
# Private MariaDB for one clone app, datadir on tmpfs (reset = stop, rsync seed copy, start).
#   mysqld.sh <name> <port>   (foreground; run by services/<name>-db.sh)
set -e
N=$1; P=$2
D=/dev/shm/clone-farm/$N-db
mkdir -p /run/mysqld && chown mysql /run/mysqld
exec /usr/sbin/mariadbd --no-defaults --user=mysql --datadir=$D --socket=/run/mysqld/$N.sock --port=$P \
  --bind-address=127.0.0.1 --pid-file=/run/mysqld/$N.pid --skip-log-bin --skip-name-resolve \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci \
  --innodb-buffer-pool-size=512M --innodb-log-file-size=64M --innodb-flush-log-at-trx-commit=0 \
  --innodb-doublewrite=0 --max-connections=300 --log-error=/workspace/clone-farm/logs/$N-db.err
