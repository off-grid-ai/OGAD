cd /dev/shm/clone-farm/opt/planka || exit 1
export NODE_ENV=production
exec node app.js --prod
