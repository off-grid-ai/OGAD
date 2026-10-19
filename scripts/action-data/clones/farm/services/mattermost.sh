# Mattermost Team Edition, foreground. Config overrides by env; data in /dev/shm.
mkdir -p /dev/shm/clone-farm/mattermost/data /dev/shm/clone-farm/mattermost/logs
export MM_SQLSETTINGS_DRIVERNAME=postgres
export MM_SQLSETTINGS_DATASOURCE='postgres://mmuser:farm-mm-db@127.0.0.1:5432/mattermost?sslmode=disable&connect_timeout=10'
export MM_SERVICESETTINGS_SITEURL=http://chat.farm.test
export MM_SERVICESETTINGS_LISTENADDRESS=127.0.0.1:7120
export MM_SERVICESETTINGS_ENABLELOCALMODE=true
export MM_SERVICESETTINGS_LOCALMODESOCKETLOCATION=/dev/shm/clone-farm/mattermost/local.sock
export MM_SERVICESETTINGS_ENABLEONBOARDINGFLOW=false
export MM_SERVICESETTINGS_ENABLESECURITYFIXALERT=false
export MM_SERVICESETTINGS_ENABLEUSERACCESSTOKENS=true
export MM_SERVICESETTINGS_ENABLEPOSTUSERNAMEOVERRIDE=false
export MM_SERVICESETTINGS_POSTEDITTIMELIMIT=-1
export MM_FILESETTINGS_DIRECTORY=/dev/shm/clone-farm/mattermost/data/
export MM_LOGSETTINGS_FILELOCATION=/dev/shm/clone-farm/mattermost/logs
export MM_LOGSETTINGS_CONSOLELEVEL=WARN
export MM_LOGSETTINGS_ENABLEDIAGNOSTICS=false
export MM_PLUGINSETTINGS_ENABLE=false
# Notifications on (hides the 'Preview Mode' banner) but SMTP points at a closed port: no mail leaves.
export MM_EMAILSETTINGS_SENDEMAILNOTIFICATIONS=true MM_EMAILSETTINGS_SMTPSERVER=127.0.0.1 MM_EMAILSETTINGS_SMTPPORT=2 MM_EMAILSETTINGS_FEEDBACKEMAIL=chat@farm.test
export MM_TEAMSETTINGS_TEAMMATENAMEDISPLAY=full_name MM_TEAMSETTINGS_LOCKTEAMMATENAMEDISPLAY=true
export MM_EMAILSETTINGS_REQUIREEMAILVERIFICATION=false
export MM_RATELIMITSETTINGS_ENABLE=false
export MM_TEAMSETTINGS_MAXUSERSPERTEAM=500
export MM_ANNOUNCEMENTSETTINGS_ADMINNOTICESENABLED=false
export MM_ANNOUNCEMENTSETTINGS_USERNOTICESENABLED=false
[[ -x /workspace/clone-farm/bin-native/mattermost && -d /dev/shm/clone-farm/app/mattermost/client ]] || bash /workspace/action-data-gen/scripts/clones/farm/mattermost/install.sh
cd /dev/shm/clone-farm/app/mattermost
exec /workspace/clone-farm/bin-native/mattermost
