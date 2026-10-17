#!/usr/bin/env bash
# Recreate missing farm databases from /workspace/clone-farm/snap/db (after the container disk was erased).
# Existing databases are left alone. Seed templates come back as <app>_seed, live DBs as copies of them.
set -e
O=/workspace/clone-farm/snap/db
P() { su postgres -c "$1"; }
has() { [[ "$(P "psql -tAc \"select 1 from pg_database where datname='$1'\"")" == 1 ]]; }
[[ -f $O/pg-roles.sql ]] && P "psql -q -f $O/pg-roles.sql" >/dev/null 2>&1 || true
for f in $O/pg-*.dump; do
  [[ -e $f ]] || continue
  db=$(basename $f .dump); db=${db#pg-}
  if ! has $db; then
    owner=$(awk -v d=$db '$1 == d {print $2}' $O/pg-owners.txt)
    P "createdb -T template0 ${owner:+-O $owner} $db" && P "pg_restore -d $db --no-acl $f" >/dev/null 2>&1 || true
    echo "restored pg $db"
  fi
  live=${db%_seed}
  if [[ $live != $db ]] && ! has $live; then
    lo=$(awk -v d=$live '$1 == d {print $2}' $O/pg-owners.txt); P "createdb -T $db ${lo:+-O $lo} $live"; echo "created pg $live"
  fi
done
[[ -f $O/mariadb-users.sql ]] && mysql -f < $O/mariadb-users.sql >/dev/null 2>&1 || true
for f in $O/mariadb-*.sql.gz; do
  [[ -e $f ]] || continue
  db=$(basename $f .sql.gz); db=${db#mariadb-}
  if [[ -z "$(mysql -N -e "show databases like '$db'")" ]]; then mysql -e "create database \`$db\`"; zcat $f | mysql $db; echo "restored mariadb $db"; fi
done
