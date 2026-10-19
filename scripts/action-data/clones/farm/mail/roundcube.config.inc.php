<?php
// Roundcube on the clone farm: IMAP/SMTP on localhost, SQLite in /dev/shm (reset from a seed copy).
$config['db_dsnw'] = 'sqlite:////dev/shm/clone-farm/roundcube/rc.db?mode=0646';
$config['imap_host'] = '127.0.0.1:143';
$config['smtp_host'] = '127.0.0.1:25';
$config['smtp_user'] = '';
$config['smtp_pass'] = '';
$config['username_domain'] = 'farm.test';
$config['support_url'] = '';
$config['product_name'] = 'Mail';
$config['des_key'] = 'farm-roundcube-key-24ch!';
$config['plugins'] = ['archive', 'zipdownload', 'markasjunk'];
$config['archive_mbox'] = 'Archive';
$config['skin'] = 'elastic';
$config['enable_installer'] = false;
$config['log_dir'] = '/workspace/clone-farm/logs/roundcube/';
$config['temp_dir'] = '/dev/shm/clone-farm/roundcube-tmp/';
$config['session_lifetime'] = 0;
$config['ip_check'] = false;
$config['mail_pagesize'] = 50;
$config['draft_autosave'] = 0;
$config['refresh_interval'] = 0;
