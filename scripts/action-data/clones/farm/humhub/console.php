<?php
// Console config: the CLI installer and the farm seed controller (seed/humhub_seed.php).
require_once '/workspace/action-data-gen/scripts/clones/seed/humhub_seed.php';
return ['controllerMap' => [
    'installer' => 'humhub\\modules\\installer\\commands\\InstallController',
    'farm-seed' => 'FarmSeedController',
]];
