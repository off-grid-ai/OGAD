#!/usr/bin/env bash
# Copy every farm database's SEED state to /workspace/clone-farm/snap/db (the container disk can be erased).
# Postgres: roles + one custom-format dump per seed template (<app>_seed) or seed-less DB. MariaDB (shared): users + DBs.
# Run after any re-seed. restore-dbs.sh puts them back.
set -e
O=/workspace/clone-farm/snap/db; mkdir -p $O
P() { su postgres -c "$1"; }
P "pg_dumpall --roles-only" > $O/pg-roles.sql
P "psql -tAc \"select datname || ' ' || pg_get_userbyid(datdba) from pg_database\"" > $O/pg-owners.txt
for db in $(P "psql -tAc \"select datname from pg_database where datname like '%\\_seed' or datname in ('farm_nocodb')\""); do
  P "pg_dump -Fc $db" > $O/pg-$db.dump; echo "pg $db $(du -h $O/pg-$db.dump | cut -f1)"
done
{ for u in $(mysql -N -e "select concat(quote(user),'@',quote(host)) from mysql.user where user not in ('root','mysql','mariadb.sys')"); do
    mysql -N -e "show create user $u"; echo ';'; mysql -N -e "show grants for $u" | sed 's/$/;/'; done; } > $O/mariadb-users.sql
for db in $(mysql -N -e "select schema_name from information_schema.schemata where schema_name not in ('information_schema','mysql','performance_schema','sys')"); do
  mysqldump --single-transaction --routines $db | gzip > $O/mariadb-$db.sql.gz; echo "mariadb $db"
done
