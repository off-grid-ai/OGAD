#!/usr/bin/env bash
# Reset the shop clone (WooCommerce) to the seed: DB datadir + www tree. ~2-4 s.
set -e
F=/workspace/clone-farm; L=/dev/shm/clone-farm
[[ -f $L/shop-www/wp-load.php ]] || { mkdir -p $L/shop-www && tar -C $L -xzf $F/snap/shop-www.tgz; }
bash /workspace/action-data-gen/scripts/clones/farm/shop/dbreset.sh shop
