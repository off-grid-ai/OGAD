<?php
/**
 * Synthetic store for the shop clone (WooCommerce on shop.farm.test). No real people or products.
 *   SHOP_PASS=... wp --allow-root --path=/dev/shm/clone-farm/shop-www eval-file shop_seed.php
 * 15 categories, ~840 products (clothing and footwear as variable products with size and colour),
 * 30 customers, ~2,500 reviews, ~160 orders, 10 coupons. Deterministic (mt_srand).
 */
mt_srand(20261016);
function pick($a) { return $a[mt_rand(0, count($a) - 1)]; }
function chance($p) { return mt_rand() / mt_getrandmax() < $p; }
$PASS = getenv('SHOP_PASS') ?: 'farm';

// ---------- store settings ----------
$opts = [
  'blogname' => 'Bazaar', 'blogdescription' => 'Everything you need, delivered',
  'woocommerce_currency' => 'INR', 'woocommerce_default_country' => 'IN:MH', 'woocommerce_store_address' => '14 Market Road',
  'woocommerce_store_city' => 'Pune', 'woocommerce_store_postcode' => '411001', 'woocommerce_price_num_decimals' => '0',
  'woocommerce_coming_soon' => 'no', 'woocommerce_store_pages_only' => 'no', 'woocommerce_enable_coupons' => 'yes',
  'woocommerce_enable_reviews' => 'yes', 'woocommerce_enable_review_rating' => 'yes', 'woocommerce_review_rating_required' => 'yes',
  'woocommerce_review_rating_verification_required' => 'no', 'woocommerce_enable_guest_checkout' => 'yes',
  'woocommerce_enable_myaccount_registration' => 'yes', 'woocommerce_allow_tracking' => 'no', 'woocommerce_show_marketplace_suggestions' => 'no',
  'woocommerce_task_list_hidden' => 'yes', 'woocommerce_task_list_complete' => 'yes', 'woocommerce_extended_task_list_hidden' => 'yes',
  'woocommerce_onboarding_profile' => ['skipped' => true], 'woocommerce_manage_stock' => 'yes', 'woocommerce_notify_low_stock_amount' => '3',
  'woocommerce_hide_out_of_stock_items' => 'no', 'woocommerce_feature_order_attribution_enabled' => 'no', 'woocommerce_analytics_enabled' => 'no',
  'woocommerce_ship_to_countries' => 'specific', 'woocommerce_specific_ship_to_countries' => ['IN'], 'woocommerce_allowed_countries' => 'specific',
  'woocommerce_specific_allowed_countries' => ['IN'], 'woocommerce_calc_taxes' => 'no', 'woocommerce_catalog_columns' => 4,
  'woocommerce_catalog_rows' => 6, 'woocommerce_myaccount_downloads_endpoint' => '', 'show_on_front' => 'page',
  'woocommerce_cod_settings' => ['enabled' => 'yes', 'title' => 'Cash on delivery', 'description' => 'Pay with cash when your order arrives.', 'instructions' => 'Pay with cash on delivery.', 'enable_for_methods' => [], 'enable_for_virtual' => 'yes'],
  'woocommerce_cheque_settings' => ['enabled' => 'yes', 'title' => 'Pay by cheque', 'description' => 'Send a cheque to Bazaar, 14 Market Road, Pune.', 'instructions' => ''],
  'woocommerce_bacs_settings' => ['enabled' => 'no'], 'woocommerce_ppcp-gateway_settings' => ['enabled' => 'no'],
  'permalink_structure' => '/%postname%/',
];
foreach ($opts as $k => $v) update_option($k, $v);
update_option('page_on_front', get_option('woocommerce_shop_page_id'));
global $wp_rewrite; $wp_rewrite->set_permalink_structure('/%postname%/');
foreach (['sample-page', 'hello-world'] as $slug) { $p = get_page_by_path($slug, OBJECT, ['page', 'post']); if ($p) wp_delete_post($p->ID, true); }

// Shipping: India, flat rate with free delivery over 499.
if (!WC_Shipping_Zones::get_zones()) {
  $z = new WC_Shipping_Zone(); $z->set_zone_name('India'); $z->add_location('IN', 'country'); $z->save();
  $i = $z->add_shipping_method('flat_rate'); update_option("woocommerce_flat_rate_{$i}_settings", ['title' => 'Standard delivery', 'cost' => '49', 'tax_status' => 'none']);
  $i = $z->add_shipping_method('free_shipping'); update_option("woocommerce_free_shipping_{$i}_settings", ['title' => 'Free delivery', 'requires' => 'min_amount', 'min_amount' => '499']);
}

// ---------- attributes ----------
function ensure_attr($slug, $name, $terms) {
  $id = wc_attribute_taxonomy_id_by_name($slug);
  if (!$id) $id = wc_create_attribute(['name' => $name, 'slug' => $slug, 'type' => 'select', 'order_by' => 'menu_order', 'has_archives' => false]);
  $tax = wc_attribute_taxonomy_name($slug);
  register_taxonomy($tax, ['product'], ['hierarchical' => false, 'show_ui' => false]);
  foreach ($terms as $t) if (!term_exists($t, $tax)) wp_insert_term($t, $tax);
  return [$id, $tax];
}
$SIZES = ['S', 'M', 'L', 'XL', 'XXL'];
$SHOE = ['UK 6', 'UK 7', 'UK 8', 'UK 9', 'UK 10'];
$COLOURS = ['Black', 'White', 'Navy Blue', 'Grey', 'Olive Green', 'Maroon', 'Beige', 'Sky Blue', 'Red', 'Mustard'];
[$sizeId, $sizeTax] = ensure_attr('size', 'Size', array_merge($SIZES, $SHOE));
[$colId, $colTax] = ensure_attr('colour', 'Colour', $COLOURS);

// ---------- catalogue ----------
$CATS = [
  'Mobiles' => [[8999, 79999], ['Novaa', 'Zentro', 'Kirin', 'Lumio', 'Orbit', 'Vayu'], ['5G Smartphone', 'Pro 5G', 'Lite 4G Phone', 'Max 5G', 'Neo 5G', 'Ultra 5G'], ['8 GB RAM, 128 GB', '6 GB RAM, 128 GB', '12 GB RAM, 256 GB', '8 GB RAM, 256 GB'], 'phone'],
  'Laptops' => [[28999, 159999], ['Arcbook', 'Kestrel', 'Lumio', 'Northbyte', 'Zentro'], ['14" Thin Laptop', '15.6" Gaming Laptop', '13" Ultrabook', '16" Creator Laptop', '14" 2-in-1 Laptop'], ['i5, 16 GB, 512 GB SSD', 'Ryzen 7, 16 GB, 1 TB SSD', 'i7, 32 GB, 1 TB SSD', 'Ryzen 5, 8 GB, 512 GB SSD'], 'laptop'],
  'Headphones' => [[699, 24999], ['Sonique', 'Boomr', 'Zentro', 'Hushh', 'Pulse'], ['Wireless Earbuds', 'Over-Ear ANC Headphones', 'Neckband', 'Wired Earphones', 'Open-Ear Buds', 'Gaming Headset'], ['40h Battery', 'with ANC', 'Bluetooth 5.3', 'Low Latency', 'with Mic'], 'audio'],
  'Smartwatches' => [[1499, 39999], ['Fitbeat', 'Orbit', 'Pulse', 'Tempo', 'Zentro'], ['Smartwatch', 'Fitness Band', 'AMOLED Smartwatch', 'GPS Sports Watch', 'Kids Smartwatch'], ['1.43" AMOLED', 'with SpO2', 'Bluetooth Calling', '10-Day Battery', 'Rugged Build'], 'watch'],
  'Cameras' => [[4999, 189999], ['Optix', 'Lumen', 'Kestrel', 'Shutterbug'], ['Mirrorless Camera', 'Action Camera', 'Instant Camera', 'DSLR Camera', 'Vlogging Camera', 'Security Camera'], ['24 MP', '4K60', 'with 18-55mm Lens', 'Waterproof', 'Wi-Fi'], 'camera'],
  'Televisions' => [[12999, 249999], ['Vistara', 'Lumio', 'Northbyte', 'Zentro'], ['32" HD Smart TV', '43" 4K Smart TV', '55" QLED TV', '65" 4K Google TV', '50" OLED TV'], ['Dolby Audio', 'HDR10+', '120 Hz', 'Voice Remote'], 'tv'],
  'Kitchen Appliances' => [[499, 34999], ['Rasoi', 'Homely', 'Chefmate', 'Tadka', 'Brewmaster'], ['Mixer Grinder', 'Air Fryer', 'Electric Kettle', 'Induction Cooktop', 'Coffee Maker', 'Pressure Cooker', 'Microwave Oven', 'Toaster'], ['750 W', '1.5 L', '3 Jars', 'Digital Display', '5 L Basket', 'Stainless Steel'], 'kitchen'],
  'Home Decor' => [[249, 14999], ['Aangan', 'Nook', 'Haveli', 'Kosha'], ['Wall Clock', 'Table Lamp', 'Ceramic Vase', 'Cotton Cushion Cover Set', 'Wall Art Print', 'Scented Candle Set', 'Jute Rug', 'Photo Frame Set'], ['Handmade', 'Set of 5', 'Large', 'Boho', 'Minimal'], 'decor'],
  'Furniture' => [[1999, 89999], ['Woodcraft', 'Nook', 'Sheesham Co', 'Comfy'], ['Study Table', 'Office Chair', 'Bookshelf', '3-Seater Sofa', 'Queen Bed', 'Shoe Rack', 'Coffee Table', 'Wardrobe'], ['Engineered Wood', 'Solid Sheesham', 'Ergonomic', 'Walnut Finish', 'with Storage'], 'furniture'],
  "Men's Clothing" => [[399, 4999], ['Urban Thread', 'Kurta Co', 'Denimwala', 'Basics+', 'Trailhead'], ['Cotton T-Shirt', 'Slim Fit Jeans', 'Linen Shirt', 'Polo T-Shirt', 'Hoodie', 'Chinos', 'Kurta', 'Track Pants'], ['Regular Fit', 'Slim Fit', 'Pure Cotton', 'Stretch'], 'tee'],
  "Women's Clothing" => [[449, 6999], ['Saanjh', 'Urban Thread', 'Kurti House', 'Basics+', 'Lila'], ['Cotton Kurti', 'A-Line Dress', 'Palazzo Pants', 'Crop Top', 'Anarkali Kurta', 'Denim Jacket', 'Leggings', 'Maxi Dress'], ['Printed', 'Rayon', 'Embroidered', 'Flared'], 'dress'],
  'Footwear' => [[499, 9999], ['Stride', 'Trailhead', 'Paduka', 'Sprint'], ['Running Shoes', 'Casual Sneakers', 'Leather Loafers', 'Sports Sandals', 'Flip Flops', 'Formal Shoes', 'Hiking Boots'], ['Lightweight', 'Memory Foam', 'Slip-On', 'Lace-Up'], 'shoe'],
  'Books' => [[149, 1999], ['Penguin Bear', 'Harbor House', 'Little Lamp', 'Indigo Press'], ['The Quiet Monsoon', 'Atomic Routines', 'Code of the Hills', 'Data for Everyone', 'The Spice Road', 'A Short History of Tea', 'Ten Thousand Steps', 'The Night Train to Goa', 'Learning Python Fast', 'Mindful Money'], ['Paperback', 'Hardcover', 'Second Edition'], 'book'],
  'Toys & Games' => [[199, 7999], ['Funbox', 'Kidzo', 'Brainy', 'Playmate'], ['Building Blocks Set', 'Remote Control Car', 'Board Game', 'Jigsaw Puzzle', 'Soft Toy', 'Science Kit', 'Doll House', 'Card Game'], ['500 Pieces', 'Ages 6+', 'Family Edition', 'Rechargeable'], 'toy'],
  'Sports & Fitness' => [[299, 29999], ['Sprint', 'Fitbeat', 'Ironhouse', 'Yogi'], ['Yoga Mat', 'Adjustable Dumbbells', 'Cricket Bat', 'Football', 'Badminton Racquet', 'Treadmill', 'Resistance Bands', 'Cycling Helmet'], ['6 mm', '20 kg Set', 'Kashmir Willow', 'Size 5', 'Pack of 5'], 'sport'],
];
$CAT_IDS = [];
foreach ($CATS as $name => $_) { $t = term_exists($name, 'product_cat') ?: wp_insert_term($name, 'product_cat'); $CAT_IDS[$name] = (int) $t['term_id']; }
$uncat = get_term_by('slug', 'uncategorized', 'product_cat'); if ($uncat) update_option('default_product_cat', $CAT_IDS['Mobiles']);

// Product images: one plain 600x600 JPEG per product (category colour + product name), no sub-sizes.
global $FONT, $PALETTE, $up;
$FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
$PALETTE = [[37, 99, 235], [220, 38, 38], [5, 150, 105], [217, 119, 6], [124, 58, 237], [8, 145, 178], [190, 24, 93], [71, 85, 105], [101, 163, 13], [234, 88, 12], [79, 70, 229], [13, 148, 136], [147, 51, 234], [202, 138, 4], [30, 64, 175]];
$up = wp_upload_dir(); @mkdir($up['basedir'] . '/products', 0755, true);
function make_image($pid, $title, $cat, $ci) {
  global $FONT, $PALETTE, $up;
  $im = imagecreatetruecolor(600, 600); [$r, $g, $b] = $PALETTE[$ci % count($PALETTE)];
  imagefill($im, 0, 0, imagecolorallocate($im, 248, 248, 250));
  imagefilledrectangle($im, 60, 60, 540, 400, imagecolorallocate($im, $r, $g, $b));
  imagefilledellipse($im, 300, 230, 220, 220, imagecolorallocate($im, min(255, $r + 60), min(255, $g + 60), min(255, $b + 60)));
  $dark = imagecolorallocate($im, 30, 30, 40);
  $words = explode(' ', $title); $lines = []; $cur = '';
  foreach ($words as $w) { if (strlen("$cur $w") > 24) { $lines[] = trim($cur); $cur = $w; } else $cur .= " $w"; }
  $lines[] = trim($cur);
  $y = 450; foreach (array_slice($lines, 0, 3) as $l) { imagettftext($im, 22, 0, 60, $y, $dark, $FONT, $l); $y += 36; }
  $file = $up['basedir'] . "/products/p$pid.jpg"; imagejpeg($im, $file, 82); imagedestroy($im);
  $aid = wp_insert_attachment(['post_mime_type' => 'image/jpeg', 'post_title' => $title, 'post_status' => 'inherit', 'guid' => $up['baseurl'] . "/products/p$pid.jpg"], $file, $pid);
  update_post_meta($aid, '_wp_attached_file', "products/p$pid.jpg");
  update_post_meta($aid, '_wp_attachment_metadata', ['width' => 600, 'height' => 600, 'file' => "products/p$pid.jpg", 'sizes' => []]);
  return $aid;
}

$FEATURES = ['1-year brand warranty', 'Easy 7-day returns', 'Ships in 1-2 days', 'Top rated by customers', 'Energy efficient', 'Made in India', 'Gift-ready packaging'];
$count = 0; $ci = 0; $seenNames = [];
if (!get_posts(['post_type' => 'product', 'numberposts' => 1])) {
  foreach ($CATS as $cat => [$range, $brands, $nouns, $specs, $kind]) {
    $n = 56;
    for ($i = 0; $i < $n; $i++) {
      for ($try = 0; $try < 20; $try++) {
        $title = $kind === 'book' ? pick($nouns) . ' (' . pick($specs) . ') by ' . pick(['Meera Iyer', 'Arjun Kapoor', 'Elena Rossi', 'Kabir Das', 'Hana Tanaka', 'Rohan Nair', 'Grace Okafor', 'Tara Menon']) : pick($brands) . ' ' . pick($nouns) . ' ' . (chance(0.6) ? pick(['X', 'S', 'Z', 'Air ', 'Go ', 'Prime ', 'One ']) . mt_rand(2, 99) . ' ' : '') . pick($specs);
        $title = preg_replace('/\s+/', ' ', trim($title));
        if (!isset($seenNames[$title])) break;
      }
      $seenNames[$title] = 1;
      $variable = in_array($kind, ['tee', 'dress', 'shoe']) && chance(0.85);
      $price = (int) (round(mt_rand($range[0], $range[1]) / 10) * 10 - 1);
      $p = $variable ? new WC_Product_Variable() : new WC_Product_Simple();
      $p->set_name($title);
      $p->set_status('publish');
      $p->set_category_ids([$CAT_IDS[$cat]]);
      $p->set_sku(strtoupper(substr(preg_replace('/[^A-Za-z]/', '', $cat), 0, 3)) . '-' . (1000 + $count));
      $feat = array_slice(array_unique([pick($FEATURES), pick($FEATURES), pick($FEATURES)]), 0, 3);
      $p->set_short_description('<ul><li>' . implode('</li><li>', $feat) . '</li></ul>');
      $p->set_description("<p>$title. " . pick(['Built for everyday use', 'Designed for comfort and style', 'A customer favourite', 'Great value for money', 'Premium quality at a fair price']) . '.</p><p>Seller: ' . pick(['Bazaar Retail', 'Nova Traders', 'Kirana Express', 'Metro Mart', 'Sapna Sales']) . '. Returns: ' . pick(['7-day replacement', '10-day return', '30-day return', 'No returns']) . '.</p>');
      $p->set_reviews_allowed(true);
      $p->set_weight((string) (mt_rand(1, 80) / 10));
      if (!$variable) {
        $p->set_regular_price($price);
        if (chance(0.3)) $p->set_sale_price((int) (round($price * (1 - mt_rand(5, 40) / 100) / 10) * 10 - 1));
        $p->set_manage_stock(true);
        $p->set_stock_quantity(chance(0.08) ? 0 : mt_rand(1, 120));
      }
      if ($variable) {
        $sizes = $kind === 'shoe' ? $SHOE : $SIZES;
        $cols = array_slice(array_values(array_unique([pick($COLOURS), pick($COLOURS), pick($COLOURS)])), 0, mt_rand(1, 3));
        $a1 = new WC_Product_Attribute(); $a1->set_id($sizeId); $a1->set_name($sizeTax); $a1->set_options(array_map(fn($s) => get_term_by('name', $s, $sizeTax)->term_id, $sizes)); $a1->set_visible(true); $a1->set_variation(true);
        $a2 = new WC_Product_Attribute(); $a2->set_id($colId); $a2->set_name($colTax); $a2->set_options(array_map(fn($c) => get_term_by('name', $c, $colTax)->term_id, $cols)); $a2->set_visible(true); $a2->set_variation(true);
        $p->set_attributes([$a1, $a2]);
      }
      $pid = $p->save();
      if ($variable) {
        $sale = chance(0.3) ? mt_rand(10, 40) : 0;
        foreach ($sizes as $s) foreach ($cols as $c) {
          $v = new WC_Product_Variation(); $v->set_parent_id($pid);
          $v->set_attributes([$sizeTax => get_term_by('name', $s, $sizeTax)->slug, $colTax => get_term_by('name', $c, $colTax)->slug]);
          $v->set_regular_price($price); if ($sale) $v->set_sale_price((int) (round($price * (1 - $sale / 100) / 10) * 10 - 1));
          $v->set_manage_stock(true); $v->set_stock_quantity(chance(0.1) ? 0 : mt_rand(1, 40)); $v->set_sku('');
          $v->save();
        }
        WC_Product_Variable::sync($pid);
      }
      $aid = make_image($pid, $title, $cat, $ci);
      set_post_thumbnail($pid, $aid);
      if (chance(0.06)) { $pp = wc_get_product($pid); $pp->set_featured(true); $pp->save(); }
      $count++;
    }
    $ci++;
  }
}
WP_CLI::log("products: $count");

// ---------- customers ----------
$FIRST = ['Asha', 'Rohan', 'Meera', 'Kabir', 'Priya', 'Arjun', 'Neha', 'Vikram', 'Isha', 'Dev', 'Ananya', 'Karan', 'Tara', 'Nikhil', 'Sana', 'Rahul', 'Leela', 'Aditya', 'Zoya', 'Farhan', 'Diya', 'Omar', 'Ritu', 'Samir', 'Pooja', 'Elena', 'Lucas', 'Hana', 'Mateo', 'Grace'];
$LAST = ['Rao', 'Mehta', 'Iyer', 'Khan', 'Nair', 'Sharma', 'Das', 'Kapoor', 'Joshi', 'Bose', 'Pillai', 'Singh', 'Menon', 'Reddy', 'Gupta', 'Ali', 'Fernandes', 'Chatterjee', 'Kulkarni', 'Banerjee', 'Shah', 'Verma', 'Patel', 'Rossi', 'Silva', 'Tanaka', 'Okafor', 'Novak', 'Berg', 'Moreau'];
$ADDR = [['Pune', 'MH', '4110'], ['Bengaluru', 'KA', '5600'], ['Mumbai', 'MH', '4000'], ['New Delhi', 'DL', '1100'], ['Hyderabad', 'TS', '5000'], ['Chennai', 'TN', '6000'], ['Panaji', 'GA', '4030'], ['Jaipur', 'RJ', '3020'], ['Kolkata', 'WB', '7000'], ['Kochi', 'KL', '6820']];
$STREETS = ['MG Road', 'Linking Road', 'Park Street', 'FC Road', 'Residency Road', 'Anna Salai', 'Banjara Hills Road 2', 'Church Street', 'Hill Road', 'Lake View Road'];
$CUST = [];
for ($i = 0; $i < 30; $i++) {
  $f = $FIRST[$i]; $l = $LAST[($i * 7) % 30]; $login = strtolower("$f.$l");
  $uid = username_exists($login);
  if (!$uid) {
    $uid = wc_create_new_customer("$login@farm.test", $login, $PASS, ['first_name' => $f, 'last_name' => $l]);
    $c = new WC_Customer($uid); [$city, $st, $pin] = $ADDR[$i % 10];
    $addr = ['first_name' => $f, 'last_name' => $l, 'address_1' => mt_rand(2, 220) . ', ' . $STREETS[($i * 3) % 10], 'address_2' => pick(['Flat 3B', 'Apt 702', 'Near City Mall', 'Block C', '']), 'city' => $city, 'state' => $st, 'postcode' => $pin . str_pad(mt_rand(1, 99), 2, '0', STR_PAD_LEFT), 'country' => 'IN'];
    foreach ($addr as $k => $v) { $c->{"set_billing_$k"}($v); $c->{"set_shipping_$k"}($v); }
    $c->set_billing_phone('98' . mt_rand(10000000, 99999999)); $c->set_billing_email("$login@farm.test"); $c->set_display_name("$f $l");
    $c->save();
  }
  $CUST[] = $uid;
}
WP_CLI::log('customers: ' . count($CUST));

// ---------- reviews ----------
$GOOD = ['Excellent quality, worth every rupee.', 'Works exactly as described. Fast delivery.', 'Very happy with this purchase.', 'Great value for money. Recommended.', 'Looks premium and feels sturdy.', 'Second one I have bought, still great.', 'Battery life is impressive.', 'Fits perfectly and the colour is true to the photo.'];
$MID = ['Decent for the price, packaging could be better.', 'Okay product, a bit smaller than expected.', 'Good but delivery took a week.', 'Average quality, does the job.'];
$BAD = ['Stopped working after two weeks.', 'Not as shown in the picture.', 'Poor build quality, returned it.'];
$all = get_posts(['post_type' => 'product', 'numberposts' => -1, 'fields' => 'ids', 'orderby' => 'ID', 'order' => 'ASC']);
global $wpdb;
if (!$wpdb->get_var("SELECT COUNT(*) FROM $wpdb->comments WHERE comment_type='review'")) {
  $nrev = 0;
  foreach ($all as $pid) {
    $k = mt_rand(0, 6); $bias = mt_rand(0, 2);
    foreach ((array) array_rand(array_flip($CUST), max(1, $k)) as $uid) {
      if ($k === 0) break;
      $u = get_userdata($uid); $r = min(5, max(1, mt_rand(2, 5) + ($bias - 1) + (chance(0.4) ? 1 : 0)));
      $text = $r >= 4 ? pick($GOOD) : ($r == 3 ? pick($MID) : pick($BAD));
      $date = date('Y-m-d H:i:s', strtotime('2026-10-01') - mt_rand(0, 300) * 86400);
      $cid = wp_insert_comment(['comment_post_ID' => $pid, 'comment_author' => $u->display_name, 'comment_author_email' => $u->user_email, 'comment_content' => $text, 'comment_type' => 'review', 'comment_approved' => 1, 'user_id' => $uid, 'comment_date' => $date, 'comment_date_gmt' => $date]);
      add_comment_meta($cid, 'rating', $r); add_comment_meta($cid, 'verified', 1); $nrev++;
    }
  }
  foreach ($all as $pid) {
    $p = wc_get_product($pid);
    $p->set_rating_counts(WC_Comments::get_rating_counts_for_product($p)); $p->set_average_rating(WC_Comments::get_average_rating_for_product($p)); $p->set_review_count(WC_Comments::get_review_count_for_product($p));
    $p->save();
  }
  WP_CLI::log("reviews: $nrev");
}

// ---------- coupons ----------
$COUPONS = [['SAVE10', 'percent', 10, 0], ['WELCOME15', 'percent', 15, 999], ['FESTIVE20', 'percent', 20, 2999], ['FLAT200', 'fixed_cart', 200, 1499], ['FLAT500', 'fixed_cart', 500, 4999], ['BOOKS25', 'percent', 25, 0], ['MONSOON12', 'percent', 12, 0], ['FREESHIP', 'fixed_cart', 49, 0], ['DIWALI30', 'percent', 30, 9999], ['NEWUSER100', 'fixed_cart', 100, 499]];
foreach ($COUPONS as [$code, $type, $amt, $min]) {
  if (wc_get_coupon_id_by_code($code)) continue;
  $c = new WC_Coupon(); $c->set_code($code); $c->set_discount_type($type); $c->set_amount($amt); if ($min) $c->set_minimum_amount($min);
  if ($code === 'BOOKS25') $c->set_product_categories([$CAT_IDS['Books']]);
  $c->set_description("$code: " . ($type === 'percent' ? "$amt% off" : "₹$amt off") . ($min ? " on orders over ₹$min" : '')); $c->save();
}

// ---------- orders ----------
$simple = array_values(array_filter($all, fn($id) => wc_get_product($id)->is_type('simple')));
$varp = array_values(array_filter($all, fn($id) => wc_get_product($id)->is_type('variable')));
if (!wc_get_orders(['limit' => 1, 'return' => 'ids'])) {
  $STAT = ['completed', 'completed', 'completed', 'processing', 'processing', 'on-hold', 'cancelled', 'pending', 'refunded'];
  for ($o = 0; $o < 160; $o++) {
    $uid = $o < 14 ? $CUST[0] : pick($CUST); $c = new WC_Customer($uid);
    $order = wc_create_order(['customer_id' => $uid]);
    for ($j = 0, $m = mt_rand(1, 3); $j < $m; $j++) {
      if (chance(0.3) && $varp) { $vp = wc_get_product(pick($varp)); $kids = $vp->get_children(); $order->add_product(wc_get_product(pick($kids)), mt_rand(1, 2)); }
      else $order->add_product(wc_get_product(pick($simple)), mt_rand(1, 2));
    }
    foreach (['first_name', 'last_name', 'address_1', 'address_2', 'city', 'state', 'postcode', 'country'] as $k) { $order->{"set_billing_$k"}($c->{"get_billing_$k"}()); $order->{"set_shipping_$k"}($c->{"get_shipping_$k"}()); }
    $order->set_billing_email($c->get_billing_email()); $order->set_billing_phone($c->get_billing_phone());
    $order->set_payment_method(chance(0.85) ? 'cod' : 'cheque'); $order->set_payment_method_title($order->get_payment_method() === 'cod' ? 'Cash on delivery' : 'Pay by cheque');
    $ship = new WC_Order_Item_Shipping(); $ship->set_method_title('Standard delivery'); $ship->set_method_id('flat_rate'); $ship->set_total(49); $order->add_item($ship);
    $order->calculate_totals(false);
    $status = $o < 14 ? ['processing', 'completed', 'completed', 'on-hold', 'completed', 'cancelled', 'processing', 'completed', 'refunded', 'completed', 'pending', 'completed', 'processing', 'completed'][$o] : pick($STAT);
    $order->set_status($status);
    $d = strtotime('2026-10-15') - ($o < 14 ? $o * 19 : mt_rand(0, 360)) * 86400 - mt_rand(0, 86000);
    $order->set_date_created($d);
    if ($status === 'completed') { $order->set_date_completed($d + 4 * 86400); $order->set_date_paid($d + 4 * 86400); }
    $order->save();
  }
  WP_CLI::log('orders: 160');
}

$wl = get_page_by_path('wishlist'); if (!$wl) $wl = get_post(wp_insert_post(['post_type' => 'page', 'post_status' => 'publish', 'post_title' => 'Wishlist', 'post_name' => 'wishlist', 'post_content' => '<!-- wp:shortcode -->[yith_wcwl_wishlist]<!-- /wp:shortcode -->']));
if ($wl) update_option('yith_wcwl_wishlist_page_id', $wl->ID);
// Wishlist page from YITH (created on activation) and menus: keep Storefront's default page menu.
flush_rewrite_rules(true);
WP_CLI::log('done');
