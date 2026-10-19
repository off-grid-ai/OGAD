mkdir -p /run/php
exec php-fpm8.3 -R -F -y /workspace/clone-farm/nginx/php-fpm.conf
