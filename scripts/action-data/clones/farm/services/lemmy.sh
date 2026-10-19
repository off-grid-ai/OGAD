[[ -x /workspace/clone-farm/src/lemmy/lemmy_server ]] || bash /workspace/action-data-gen/scripts/clones/farm/lemmy/install.sh
export LEMMY_CONFIG_LOCATION=/workspace/clone-farm/lemmy/lemmy.hjson RUST_LOG=warn
exec /workspace/clone-farm/src/lemmy/lemmy_server
