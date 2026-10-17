mkdir -p /var/run/postgresql && chown postgres /var/run/postgresql
exec su postgres -c '/usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql/16/main -c config_file=/etc/postgresql/16/main/postgresql.conf'
