#!/usr/bin/env bash
# Rebuild the webmail code trees in /dev/shm (tmpfs: lost on pod restart). Configs come from the repo mirror.
set -e
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
F=/workspace/clone-farm; S=/workspace/action-data-gen/scripts/clones/farm; D=/dev/shm/clone-farm/src
mkdir -p $D && cd $D
[[ -f $F/src/rc.tgz ]] || curl -sL -o $F/src/rc.tgz https://github.com/roundcube/roundcubemail/releases/download/1.6.11/roundcubemail-1.6.11-complete.tar.gz
[[ -f $F/src/sm.tgz ]] || curl -sL -o $F/src/sm.tgz https://github.com/the-djmaze/snappymail/releases/download/v2.38.2/snappymail-2.38.2.tar.gz
if [[ ! -d roundcube ]]; then tar --no-same-owner -xzf $F/src/rc.tgz && mv roundcubemail-1.6.11 roundcube; fi
cp $S/mail/roundcube.config.inc.php roundcube/config/config.inc.php
if [[ ! -d snappymail ]]; then
  mkdir snappymail && tar --no-same-owner -xzf $F/src/sm.tgz -C snappymail
  rm -rf snappymail/data && tar --no-same-owner -xzf $F/snap/snappymail-data.tgz -C snappymail && mv snappymail/snappymail-data snappymail/data
fi
