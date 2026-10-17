#!/usr/bin/env bash
# Clone farm service runner (no systemd in the pod).
#   farm.sh start [name...]   farm.sh stop [name...]   farm.sh status
# Each services/<name>.sh is a foreground command; its process group is tracked by a pid file.
set -u
F=/workspace/clone-farm
cd "$F" || exit 1
mkdir -p run logs
names() { if [[ $# -gt 0 ]]; then echo "$@"; else ls services | sed 's/\.sh$//' | sort; fi; }
alive() { [[ -f run/$1.pid ]] && kill -0 "$(cat run/$1.pid)" 2>/dev/null; }
case "${1:-status}" in
  start) shift; for n in $(names "$@"); do
      if alive "$n"; then echo "$n: running"; continue; fi
      setsid nohup bash "services/$n.sh" >> "logs/$n.log" 2>&1 < /dev/null & echo $! > "run/$n.pid"; echo "$n: started $!"
    done ;;
  stop) shift; for n in $(names "$@"); do
      if alive "$n"; then kill -TERM -- "-$(cat run/$n.pid)" 2>/dev/null; sleep 1; kill -KILL -- "-$(cat run/$n.pid)" 2>/dev/null; fi
      rm -f "run/$n.pid"; echo "$n: stopped"
    done ;;
  restart) shift; "$0" stop "$@"; "$0" start "$@" ;;
  sync) # Copy services and nginx sites from the repo mirror, then reload nginx.
    S=/workspace/action-data-gen/scripts/clones/farm
    cp "$S"/services/*.sh services/; cp "$S"/nginx/sites/*.conf nginx/sites/; cp "$S"/farm.sh bin/farm.sh
    nginx -t -c "$F/nginx/nginx.conf" && nginx -s reload -c "$F/nginx/nginx.conf" ;;
  status) for n in $(names); do alive "$n" && echo "$n: up" || echo "$n: down"; done ;;
esac
