#!/usr/bin/env bash
# Reset the wiki clone (BookStack) to the seed: DB datadir + code/uploads tree. ~2 s.
#   reset.sh --save   snapshot the current DB (and the www tree) as the seed
set -e
F=/workspace/clone-farm; L=/dev/shm/clone-farm
if [[ "${1:-}" == "--save" ]]; then
  bash /workspace/action-data-gen/scripts/clones/farm/shop/dbreset.sh wiki --save
  tar -C $L -czf $F/snap/wiki-www.tgz --exclude=wiki-www/storage/framework/sessions/* --exclude=wiki-www/storage/logs/* wiki-www
  exit 0
fi
[[ -f $L/wiki-www/artisan ]] || { mkdir -p $L && tar -C $L -xzf $F/snap/wiki-www.tgz; }
bash /workspace/action-data-gen/scripts/clones/farm/shop/dbreset.sh wiki
rm -rf $L/wiki-www/storage/framework/cache/data/* 2>/dev/null || true
