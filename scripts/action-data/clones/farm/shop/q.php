<?php
// State reader for the shop clone tasks (prints JSON). Run: php q.php <cmd> <login> [arg]
//   cart <login>      -> {items:[{product_id,variation_id,quantity,variation,name}], coupons:[...]}
//   wishlist <login>  -> [product_id...]
//   address <login>   -> billing/shipping address fields
//   orders <login>    -> latest orders [{id,status,total,payment,items,created}]
$_SERVER['HTTP_HOST'] = 'shop.farm.test';
define('WP_USE_THEMES', false);
require '/dev/shm/clone-farm/shop-www/wp-load.php';
[$cmd, $login] = [$argv[1], $argv[2]];
$u = get_user_by('login', $login);
$out = null;
if ($cmd === 'cart') {
  global $wpdb;
  $raw = $wpdb->get_var($wpdb->prepare("SELECT session_value FROM {$wpdb->prefix}woocommerce_sessions WHERE session_key=%s", (string) $u->ID));
  $s = $raw ? maybe_unserialize($raw) : [];
  $cart = isset($s['cart']) ? maybe_unserialize($s['cart']) : [];
  $items = [];
  foreach ((array) $cart as $it) $items[] = ['product_id' => $it['product_id'], 'variation_id' => $it['variation_id'], 'quantity' => $it['quantity'], 'variation' => $it['variation'], 'name' => get_the_title($it['product_id'])];
  $out = ['items' => $items, 'coupons' => isset($s['applied_coupons']) ? maybe_unserialize($s['applied_coupons']) : []];
} elseif ($cmd === 'wishlist') {
  global $wpdb;
  $out = array_map('intval', $wpdb->get_col($wpdb->prepare("SELECT i.prod_id FROM {$wpdb->prefix}yith_wcwl i JOIN {$wpdb->prefix}yith_wcwl_lists l ON l.ID=i.wishlist_id WHERE l.user_id=%d", $u->ID)));
} elseif ($cmd === 'address') {
  $c = new WC_Customer($u->ID); $out = [];
  foreach (['billing', 'shipping'] as $t) foreach (['first_name', 'last_name', 'address_1', 'address_2', 'city', 'state', 'postcode', 'phone'] as $k) if (is_callable([$c, "get_{$t}_$k"])) $out["{$t}_$k"] = $c->{"get_{$t}_$k"}();
} elseif ($cmd === 'orders') {
  $out = [];
  foreach (wc_get_orders(['customer_id' => $u->ID, 'limit' => 50, 'orderby' => 'date', 'order' => 'DESC']) as $o) {
    $out[] = ['id' => $o->get_id(), 'number' => $o->get_order_number(), 'status' => $o->get_status(), 'status_name' => wc_get_order_status_name($o->get_status()), 'total' => (float) $o->get_total(), 'payment' => $o->get_payment_method(), 'created' => $o->get_date_created()->date('F j, Y'), 'items' => array_values(array_map(fn($i) => ['name' => $i->get_name(), 'qty' => $i->get_quantity(), 'product_id' => $i->get_product_id(), 'variation_id' => $i->get_variation_id()], $o->get_items())), 'coupons' => $o->get_coupon_codes()];
  }
}
echo json_encode($out);
