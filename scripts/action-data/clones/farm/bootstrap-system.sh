#!/usr/bin/env bash
# System layer of the clone farm on a fresh container disk: apt packages, postfix, php opcache, users.
# Node 24 and Chrome come from the pod's own setup (the action-data tooling needs them anyway).
set -e
S=/workspace/action-data-gen/scripts/clones/farm
if ! command -v php-fpm8.3 >/dev/null || ! command -v dovecot >/dev/null || ! [[ -x /usr/lib/postgresql/16/bin/postgres ]]; then
  export DEBIAN_FRONTEND=noninteractive
  echo "postfix postfix/main_mailer_type select Local only" | debconf-set-selections
  echo "postfix postfix/mailname string farm.test" | debconf-set-selections
  apt-get update -q
  apt-get install -y -q --no-install-recommends php8.3-fpm php8.3-cli php8.3-sqlite3 php8.3-mysql php8.3-pgsql php8.3-gd php8.3-curl \
    php8.3-mbstring php8.3-xml php8.3-zip php8.3-intl php8.3-bcmath php8.3-gmp php8.3-apcu php8.3-imagick php8.3-ldap php8.3-redis php8.3-igbinary \
    composer unzip mariadb-server mariadb-client postgresql redis-server dovecot-imapd dovecot-lmtpd postfix sqlite3 swaks xvfb nginx psmisc socat zstd rsync
fi
bash $S/mail/postfix-setup.sh
postconf -e "virtual_mailbox_domains = farm.test northwind.test acmepay.test brightdesk.test skyroute.test greenleaf.test pixelforge.test" 'maillog_file = /var/log/postfix-farm.log'
printf 'opcache.enable=1\nopcache.memory_consumption=512\nopcache.max_accelerated_files=100000\nopcache.validate_timestamps=1\nopcache.revalidate_freq=60\n' > /etc/php/8.3/fpm/conf.d/99-farm.ini
id vmail >/dev/null 2>&1 || { groupadd -g 5000 vmail; useradd -u 5000 -g 5000 -M -s /usr/sbin/nologin vmail; }
id gitea >/dev/null 2>&1 || useradd -r -m -d /home/gitea -s /bin/bash gitea
command -v node >/dev/null || echo "WARNING: node is missing; install Node 24 before the captures" >&2
