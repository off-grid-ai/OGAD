#!/usr/bin/env bash
# Mattermost Team Edition (official linux tarball) on chat.farm.test -> 127.0.0.1:7120, shared postgres.
set -e
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
F=/workspace/clone-farm
# The app tree (370 MB) and tarball live in /dev/shm (the /workspace quota is tight).
mkdir -p /dev/shm/clone-farm/dl /dev/shm/clone-farm/app
cd /dev/shm/clone-farm/app
[[ -x mattermost/bin/mattermost ]] || { [[ -f /dev/shm/clone-farm/dl/mm.tgz ]] || curl -sSL -o /dev/shm/clone-farm/dl/mm.tgz https://releases.mattermost.com/12.0.0/mattermost-team-12.0.0-linux-amd64.tar.gz; tar --no-same-owner --exclude=mattermost/prepackaged_plugins -xzf /dev/shm/clone-farm/dl/mm.tgz; }
# /dev/shm is noexec and the root disk is reserved: the two single binaries run from /workspace/clone-farm/bin-native.
[[ -x /workspace/clone-farm/bin-native/mattermost ]] || { mkdir -p /workspace/clone-farm/bin-native; cp mattermost/bin/mattermost mattermost/bin/mmctl /workspace/clone-farm/bin-native/; chmod +x /workspace/clone-farm/bin-native/mattermost /workspace/clone-farm/bin-native/mmctl; }
su postgres -c "psql -tAc \"select 1 from pg_roles where rolname='mmuser'\"" | grep -q 1 || su postgres -c "psql -c \"create role mmuser login password 'farm-mm-db' createdb\""
su postgres -c "psql -tAc \"select 1 from pg_database where datname='mattermost'\"" | grep -q 1 || su postgres -c "psql -c 'create database mattermost owner mmuser'"
