#!/usr/bin/env bash
# Reset mail (all accounts) and the Roundcube / SnappyMail state to the seed. ~1 s.
set -e
F=/workspace/clone-farm
mkdir -p /dev/shm/clone-farm/mail /dev/shm/clone-farm/roundcube /dev/shm/clone-farm/roundcube-tmp
# The seed lives on /workspace as one tar (quota counts per file); /dev/shm holds the unpacked copy.
if [[ ! -d /dev/shm/clone-farm/snap-mail || $F/snap/mail.tgz -nt /dev/shm/clone-farm/snap-mail ]]; then
  rm -rf /dev/shm/clone-farm/snap-mail && mkdir -p /dev/shm/clone-farm/snap-mail
  tar --no-same-owner -xzf $F/snap/mail.tgz -C /dev/shm/clone-farm/snap-mail && chown -R 5000:5000 /dev/shm/clone-farm/snap-mail
fi
# reset.sh <user@domain>: only that mailbox (each webmail app owns one account); no argument: all.
if [[ -n "${1:-}" ]]; then
  u=${1%@*}; d=${1#*@}
  doveadm -c $F/mail/dovecot.conf kick "$1" >/dev/null 2>&1 || true
  mkdir -p /dev/shm/clone-farm/mail/$d/$u
  rsync -a --delete /dev/shm/clone-farm/snap-mail/$d/$u/ /dev/shm/clone-farm/mail/$d/$u/
  exit 0
fi
doveadm -c $F/mail/dovecot.conf kick '*' >/dev/null 2>&1 || true
rsync -a --delete /dev/shm/clone-farm/snap-mail/ /dev/shm/clone-farm/mail/
postsuper -d ALL >/dev/null 2>&1 || true
true
