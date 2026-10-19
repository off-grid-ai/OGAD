#!/usr/bin/env bash
# Akkoma (Twitter-like microblog, Elixir OTP release) on social.farm.test, port 7140. Reproducible install.
# Code: /opt/clone-farm/akkoma (-> /dev/shm, noexec: exec-overlay.sh moves binaries to /workspace). Config: /workspace/clone-farm/akkoma.
set -euo pipefail
mkdir -p /dev/shm/clone-farm/opt; [[ -e /opt/clone-farm ]] || ln -s /dev/shm/clone-farm/opt /opt/clone-farm
F=/workspace/clone-farm; A=/opt/clone-farm/akkoma; S=/workspace/action-data-gen/scripts/clones/farm/akkoma
[[ -f $F/src/akkoma.zip ]] || curl -sL -o $F/src/akkoma.zip https://akkoma-updates.s3-website.fr-par.scw.cloud/stable/akkoma-amd64-ubuntu-jammy.zip
if [[ ! -f $A/release/bin/pleroma ]]; then mkdir -p $A && (cd $A && unzip -qo $F/src/akkoma.zip && chmod +x release/bin/* release/erts-*/bin/*); fi
bash $S/exec-overlay.sh $A/release   # /dev/shm is noexec: binaries and NIFs go to /workspace
P() { bash $A/release/bin/pleroma "$@"; }; PC() { bash $A/release/bin/pleroma_ctl "$@"; }
mkdir -p $F/akkoma /dev/shm/clone-farm/akkoma-uploads
if [[ ! -f $A/config.exs && -f $F/akkoma/config.exs.bak ]]; then cp $F/akkoma/config.exs.bak $A/config.exs; chmod 640 $A/config.exs; fi
if [[ ! -f $A/config.exs ]]; then
  (cd $A && PC instance gen --output $A/config.exs --output-psql $F/akkoma/setup.psql --domain social.farm.test \
    --media-url http://social.farm.test/media --instance-name Chirp --admin-email admin@social.farm.test --notify-email admin@social.farm.test \
    --dbhost localhost --dbname akkoma --dbuser akkoma --dbpass akkomafarm --rum N --indexable N --db-configurable N \
    --uploads-dir /dev/shm/clone-farm/akkoma-uploads --static-dir $A/static --listen-ip 127.0.0.1 --listen-port 7140 \
    --strip-uploads-metadata N --read-uploads-description N --anonymize-uploads N < <(yes ""))
  cat $S/farm.exs >> $A/config.exs; chmod 640 $A/config.exs; cp $A/config.exs $F/akkoma/config.exs.bak
fi
export AKKOMA_CONFIG_PATH=$A/config.exs
if ! su postgres -c "psql -tAc \"select 1 from pg_database where datname='akkoma'\"" | grep -q 1; then
  su postgres -c "psql -f $F/akkoma/setup.psql"
  (cd $A && PC migrate)
fi
su postgres -c "psql -qc 'alter user akkoma superuser'"
# Frontends install through the running node (rpc): start it once if needed.
if [[ ! -d $A/static/frontends/mastodon-fe ]]; then
  (cd $A && P daemon); for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:7140/api/v1/instance && break; sleep 1; done
  (cd $A && for fe in "pleroma-fe stable" "admin-fe stable" "mastodon-fe akkoma"; do set -- $fe; PC frontend install $1 --ref $2; done; P stop)
fi
echo akkoma installed
