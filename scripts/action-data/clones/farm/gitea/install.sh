#!/usr/bin/env bash
# Gitea single binary on git.farm.test -> 127.0.0.1:7121, sqlite + repos in /dev/shm.
set -e
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
F=/workspace/clone-farm
# Single binary in /workspace/clone-farm/bin-native (/dev/shm is noexec, the root disk is reserved for training).
mkdir -p /workspace/clone-farm/bin-native
[[ -x /workspace/clone-farm/bin-native/gitea ]] || { curl -sSL -o /workspace/clone-farm/bin-native/gitea https://github.com/go-gitea/gitea/releases/download/v28.1.0/gitea-28.1.0-linux-amd64; chmod +x /workspace/clone-farm/bin-native/gitea; }
id gitea >/dev/null 2>&1 || useradd -r -m -d /home/gitea -s /bin/bash gitea
