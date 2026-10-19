[[ -f /opt/clone-farm/akkoma/release/bin/pleroma && -L /opt/clone-farm/akkoma/release/erts-14.0.2 ]] || bash /workspace/action-data-gen/scripts/clones/farm/akkoma/install.sh
export AKKOMA_CONFIG_PATH=/opt/clone-farm/akkoma/config.exs HOME=/opt/clone-farm/akkoma
mkdir -p /dev/shm/clone-farm/akkoma-uploads
exec bash /opt/clone-farm/akkoma/release/bin/pleroma start
