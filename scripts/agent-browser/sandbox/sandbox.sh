#!/usr/bin/env bash
# Off Grid web-agent sandbox sites (docs/agent-browser/SANDBOX.md in the desktop repo).
#   ./sandbox.sh up      build, start, create the test users, seed
#   ./sandbox.sh down    stop everything (data kept in docker volumes)
#   ./sandbox.sh reset   restart the four small apps (clean state) and re-seed mail + cloud
#   ./sandbox.sh seed    re-seed mail + cloud only
#   ./sandbox.sh status  containers and a https check of the six hosts
# Passwords live in .env (chmod 600). They are generated once and never printed.
set -euo pipefail
cd "$(dirname "$0")"
DC="nice -n 10 taskset -c 0-7 docker compose"
CALENDAR=calendar-v5.5.24
HOSTS="offgrid-mail.test offgrid-cloud.test offgrid-shop.test offgrid-air.test offgrid-bank.test offgrid-forms.test"

gen() { head -c 48 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 24; }
ensure_env() {
  [ -f .env ] && return
  umask 077
  { for k in MAIL CLOUD SHOP AIR BANK FORMS NEXTCLOUD_ADMIN OTHER_MAIL VAULT; do echo "${k}_PASSWORD=$(gen)"; done; } > .env
}
load_env() { set -a; . ./.env; set +a; }

mail_users() {
  local list
  list=$($DC exec -T mailserver setup email list 2>/dev/null || true)
  grep -q "alex@offgrid-mail.test" <<<"$list" || \
    $DC exec -T mailserver setup email add alex@offgrid-mail.test "$MAIL_PASSWORD" >/dev/null
  for u in priya.shah accounts dev sam lena marco jordan; do
    grep -q "$u@offgrid-mail.test" <<<"$list" || \
      $DC exec -T mailserver setup email add "$u@offgrid-mail.test" "$OTHER_MAIL_PASSWORD" >/dev/null
  done
}

wait_cloud() {
  local i
  for i in $(seq 120); do
    $DC exec -T -u www-data nextcloud php occ status 2>/dev/null | grep -q "installed: true" && return 0
    sleep 5
  done
  echo "nextcloud never finished installing" >&2; return 1
}

cloud_setup() {
  wait_cloud
  local occ="$DC exec -T -u www-data nextcloud php occ"
  # The app store download stalls here, so Calendar comes straight from its GitHub release.
  if ! $occ app:list 2>/dev/null | grep -q "calendar:"; then
    mkdir -p cache
    [ -s cache/$CALENDAR.tar.gz ] || curl -sSL -m 600 -o cache/$CALENDAR.tar.gz \
      https://github.com/nextcloud-releases/calendar/releases/download/${CALENDAR#calendar-}/$CALENDAR.tar.gz
    $DC cp cache/$CALENDAR.tar.gz nextcloud:/tmp/cal.tgz
    $DC exec -T nextcloud sh -c 'tar -xzf /tmp/cal.tgz -C /var/www/html/custom_apps && chown -R www-data:www-data /var/www/html/custom_apps/calendar && rm /tmp/cal.tgz'
  fi
  $occ app:enable calendar >/dev/null
  $occ app:disable firstrunwizard >/dev/null 2>&1 || true   # its welcome modal blocks the agent
  $occ config:system:set default_phone_region --value=US >/dev/null
  $occ config:system:set overwrite.cli.url --value=https://offgrid-cloud.test >/dev/null
  $occ user:info alex >/dev/null 2>&1 || \
    $DC exec -T -u www-data -e OC_PASS="$CLOUD_PASSWORD" nextcloud php occ user:add --password-from-env --display-name="Alex Rivera" alex >/dev/null
  $occ user:setting alex settings email alex@offgrid-mail.test >/dev/null
  $occ user:info dev >/dev/null 2>&1 || \
    $DC exec -T -u www-data -e OC_PASS="$OTHER_MAIL_PASSWORD" nextcloud php occ user:add --password-from-env --display-name="Dev Team" dev >/dev/null
  $occ user:setting dev settings email dev@offgrid-mail.test >/dev/null
}

seed() {
  docker run --rm --network agent-sandbox_default --cpuset-cpus 0-7 --cpus 1 -m 256m \
    -e MAIL_PASSWORD -e CLOUD_PASSWORD -v "$PWD/seed:/seed:ro" offgrid-sandbox-mini:1 python /seed/seed.py "$@"
}

status() {
  $DC ps --format "table {{.Service}}\t{{.Status}}\t{{.Ports}}"
  for h in $HOSTS; do
    printf '%-20s ' "$h"
    curl -sk -o /dev/null -w '%{http_code}\n' --resolve "$h:443:127.0.0.1" "https://$h/" || echo down
  done
}

case "${1:-status}" in
  up) ensure_env; load_env; $DC build shop; $DC up -d; mail_users; cloud_setup; seed; status ;;
  down) $DC down ;;
  reset) load_env; $DC restart shop air bank forms; seed ;;
  seed) load_env; shift; seed "$@" ;;
  status) status ;;
  *) echo "usage: $0 up|down|reset|seed|status"; exit 1 ;;
esac
