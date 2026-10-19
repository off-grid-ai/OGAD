# Gitea, foreground, as user gitea (it refuses root). Data lives in /dev/shm/clone-farm/gitea (reset.sh rebuilds it from the seed snapshot).
id gitea >/dev/null 2>&1 || bash /workspace/action-data-gen/scripts/clones/farm/gitea/install.sh
mkdir -p /dev/shm/clone-farm/gitea/data /dev/shm/clone-farm/gitea/home
mkdir -p /dev/shm/clone-farm/gitea-etc && cp /workspace/action-data-gen/scripts/clones/farm/gitea/app.ini /dev/shm/clone-farm/gitea-etc/app.ini
chown -R gitea:gitea /dev/shm/clone-farm/gitea-etc
chown -R gitea:gitea /dev/shm/clone-farm/gitea
exec setpriv --reuid=gitea --regid=gitea --init-groups env HOME=/dev/shm/clone-farm/gitea/home GITEA_WORK_DIR=/dev/shm/clone-farm/gitea USER=gitea /workspace/clone-farm/bin-native/gitea web --config /dev/shm/clone-farm/gitea-etc/app.ini
