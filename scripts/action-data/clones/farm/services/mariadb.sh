mkdir -p /run/mysqld && chown mysql /run/mysqld
exec mysqld_safe --bind-address=127.0.0.1
