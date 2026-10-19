<?php
// Kanboard on board.farm.test (clone farm, held-out test app). DB lives in /dev/shm; reset.sh restores the seed.
define('DATA_DIR', '/dev/shm/clone-farm/kanboard');
define('DB_DRIVER', 'sqlite');
define('DB_FILENAME', '/dev/shm/clone-farm/kanboard/db.sqlite');
define('DEBUG', false);
define('LOG_DRIVER', 'file');
define('LOG_FILE', '/dev/shm/clone-farm/kanboard/debug.log');
define('PLUGIN_INSTALLER', false);
define('ENABLE_URL_REWRITE', false);
define('MAIL_TRANSPORT', 'mail');
define('BRUTEFORCE_CAPTCHA', 1000);
define('BRUTEFORCE_LOCKDOWN', 1000);
define('SESSION_DURATION', 0);
define('CACHE_DRIVER', 'memory');
