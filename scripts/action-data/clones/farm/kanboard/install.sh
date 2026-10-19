#!/usr/bin/env bash
# Kanboard (PHP, sqlite in /dev/shm) on board.farm.test via the shared php-fpm.
# Code tree in /dev/shm (MooseFS charges ~64 KB per small file); tarball fetched on demand.
set -e
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
D=/dev/shm/clone-farm
mkdir -p $D/src $D/dl $D/kanboard
cd $D/src
[[ -f kanboard/index.php ]] || { [[ -f $D/dl/kb.tgz ]] || curl -sSL -o $D/dl/kb.tgz https://github.com/kanboard/kanboard/archive/refs/tags/v1.2.54.tar.gz; tar --no-same-owner -xzf $D/dl/kb.tgz; rm -rf kanboard; mv kanboard-1.2.54 kanboard; rm -rf kanboard/tests kanboard/docker*; }
cp /workspace/action-data-gen/scripts/clones/farm/kanboard/config.php kanboard/config.php
