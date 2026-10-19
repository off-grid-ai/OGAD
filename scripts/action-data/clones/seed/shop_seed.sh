#!/usr/bin/env bash
# Seed the shop clone: catalogue/customers/orders (shop_seed.php), then menu and sidebar widgets. Idempotent-ish.
set -e
M=/workspace/action-data-gen/scripts/clones
WP="php -d memory_limit=4096M /workspace/clone-farm/bin/wp --allow-root --path=/dev/shm/clone-farm/shop-www"
cd /tmp
export SHOP_PASS=$(python3 -c "import json;print(json.load(open('$M/farm/accounts.json'))['password'])")
$WP eval-file $M/seed/shop_seed.php
if ! $WP menu list --format=ids | grep -q .; then
  $WP menu create "Main" >/dev/null
  $WP menu item add-custom main "Today's Deals" "http://shop.farm.test/?orderby=price&on_sale=1" >/dev/null
  for c in mobiles laptops headphones televisions mens-clothing womens-clothing; do $WP menu item add-term main product_cat $($WP term get product_cat $c --by=slug --field=term_id) >/dev/null; done
  MORE=$($WP menu item add-custom main "More categories" "#" --porcelain)
  for c in smartwatches cameras kitchen-appliances home-decor furniture footwear books toys-games sports-fitness; do $WP menu item add-term main product_cat $($WP term get product_cat $c --by=slug --field=term_id) --parent-id=$MORE >/dev/null; done
  $WP menu item add-post main $($WP post list --post_type=page --name=wishlist --field=ID) --title="Wishlist" >/dev/null
  $WP menu item add-post main $($WP post list --post_type=page --name=my-account --field=ID) --title="Your Account" >/dev/null
  $WP menu location assign main primary
  $WP menu location assign main handheld
fi
if ! $WP widget list sidebar-1 --format=ids | grep -q woocommerce; then
  $WP widget reset sidebar-1 >/dev/null || true
  $WP widget add woocommerce_product_categories sidebar-1 1 --title="Categories" --count=1 >/dev/null
  $WP widget add woocommerce_rating_filter sidebar-1 2 --title="Customer rating" >/dev/null
  $WP widget add woocommerce_layered_nav sidebar-1 3 --title="Colour" --attribute=colour --display_type=list --query_type=and >/dev/null
  $WP widget add woocommerce_layered_nav sidebar-1 4 --title="Size" --attribute=size --display_type=list --query_type=and >/dev/null
  $WP widget add woocommerce_top_rated_products sidebar-1 5 --title="Top rated" --number=5 >/dev/null
fi
$WP option update woocommerce_gateway_order '{"cheque":0,"cod":1,"bacs":2}' --format=json >/dev/null
U=$($WP term get product_cat uncategorized --by=slug --field=term_id 2>/dev/null || true); [[ -n "$U" ]] && $WP term delete product_cat $U >/dev/null || true
$WP rewrite flush
echo seeded
# Clean probe/session leftovers, then snapshot: bash farm/shop/dbreset.sh shop --save
mysql --socket=/run/mysqld/shop.sock shop -e "TRUNCATE wp_woocommerce_sessions; TRUNCATE wp_yith_wcwl; TRUNCATE wp_yith_wcwl_lists; DELETE FROM wp_usermeta WHERE meta_key LIKE '_woocommerce_persistent_cart%';"
