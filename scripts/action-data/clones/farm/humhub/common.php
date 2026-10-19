<?php
// Clone-farm overrides: synchronous queue (no worker), no cache (DB resets must show at once), no mail.
return [
    'components' => [
        'queue' => ['class' => 'humhub\modules\queue\driver\Sync'],
        'cache' => ['class' => 'yii\caching\DummyCache'],
        'urlManager' => ['showScriptName' => false, 'enablePrettyUrl' => true],
        'mailer' => ['transport' => ['dsn' => 'null://null']],
    ],
    'params' => ['installed' => true],
];
