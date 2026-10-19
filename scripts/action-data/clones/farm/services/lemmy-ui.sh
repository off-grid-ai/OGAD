[[ -f /opt/clone-farm/lemmy-ui/dist/js/server.js ]] || bash /workspace/action-data-gen/scripts/clones/farm/lemmy/install.sh
cd /opt/clone-farm/lemmy-ui
export LEMMY_UI_LEMMY_INTERNAL_HOST=127.0.0.1:7141 LEMMY_UI_LEMMY_EXTERNAL_HOST=forum.farm.test LEMMY_UI_HTTPS=false LEMMY_UI_HOST=127.0.0.1:7142 NODE_ENV=production
exec node dist/js/server.js
