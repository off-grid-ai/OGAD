// WooCommerce (Storefront theme) on shop.farm.test: an Amazon-like store over a private MariaDB (port 7151).
// Seed: seed/shop_seed.sh (840 products in 15 categories, 30 customers, 2.5k reviews, 160 orders, 10 coupons).
// The shopper is asha.rao (14 past orders). State is read with farm/shop/q.php and SQL on the shop DB.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
const ORIGIN = 'http://shop.farm.test'
const USER = 'asha.rao'
const Q = '/workspace/action-data-gen/scripts/clones/farm/shop/q.php'

const sql = (sh, q) => sh('mysql --socket=/run/mysqld/shop.sock shop -N -B', { input: q, stdio: ['pipe', 'pipe', 'pipe'] })
  .trim().split('\n').filter(Boolean).map((l) => l.split('\t'))
const state = (sh, cmd) => JSON.parse(sh(`cd /tmp && php ${Q} ${cmd} ${USER}`))
const money = (n) => `₹${Math.round(Number(n)).toLocaleString('en-US')}`
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// WordPress shows straight quotes as curly / prime marks.
const loose = (s) => esc(s).replace(/"/g, '["″”“]').replace(/'/g, "['’′]").replace(/&/g, '(?:&|&amp;)')
const nameRe = (title, tail = '') => new RegExp(`^${loose(title)}${tail}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let PRODUCTS = null
/** Every published product with its lookup row (price, stock, rating) and category. Cached: the catalogue never changes. */
function products(sh) {
  if (PRODUCTS) return PRODUCTS
  PRODUCTS = sql(sh, `SELECT p.ID, p.post_title, p.post_name, l.min_price, l.max_price, l.stock_status, IFNULL(l.stock_quantity,0), l.average_rating, l.rating_count, l.onsale,
    (SELECT t.name FROM wp_term_relationships r JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id=r.term_taxonomy_id JOIN wp_terms t ON t.term_id=tt.term_id WHERE r.object_id=p.ID AND tt.taxonomy='product_cat' LIMIT 1),
    (SELECT t.slug FROM wp_term_relationships r JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id=r.term_taxonomy_id JOIN wp_terms t ON t.term_id=tt.term_id WHERE r.object_id=p.ID AND tt.taxonomy='product_cat' LIMIT 1),
    (SELECT t.slug FROM wp_term_relationships r JOIN wp_term_taxonomy tt ON tt.term_taxonomy_id=r.term_taxonomy_id JOIN wp_terms t ON t.term_id=tt.term_id WHERE r.object_id=p.ID AND tt.taxonomy='product_type' LIMIT 1)
    FROM wp_posts p JOIN wp_wc_product_meta_lookup l ON l.product_id=p.ID WHERE p.post_type='product' AND p.post_status='publish'`)
    .map(([id, title, slug, min, max, stock, qty, rating, count, onsale, cat, catSlug, type]) => ({ id: Number(id), title, slug, min: Number(min), max: Number(max), stock, qty: Number(qty), rating: Number(rating), count: Number(count), onsale: onsale === '1', cat, catSlug, type }))
  return PRODUCTS
}
const simple = (sh, min = 3) => products(sh).filter((p) => p.type === 'simple' && p.stock === 'instock' && p.qty >= min)
const productPath = (p) => `/product/${p.slug}/`

/** Puts products in the cart before the episode (not recorded); returns the cart the server holds. */
async function fillCart(page, items) {
  for (const [p, qty] of items) await page.goto(`${ORIGIN}/?add-to-cart=${p.id}&quantity=${qty}`, { waitUntil: 'load' })
  await sleep(300)
}
const cartLine = (cart, p) => cart.items.find((i) => i.product_id === p.id)

function sortSpec({ rng, sh }) {
    const all = products(sh)
    const cats = [...new Set(all.map((p) => p.catSlug))]
    const slug = rng.pick(cats)
    const inCat = all.filter((p) => p.catSlug === slug)
    const cat = inCat[0].cat
    const mode = rng.pick(['low', 'high', 'rating'])
    const sorted = [...inCat].sort(mode === 'low' ? (a, b) => a.min - b.min : mode === 'high' ? (a, b) => b.max - a.max : (a, b) => b.rating - a.rating || b.count - a.count)
    const [first, second] = sorted
    const key = (p) => (mode === 'low' ? p.min : mode === 'high' ? p.max : `${p.rating}:${p.count}`)
    if (second && key(first) === key(second)) return null
    const option = mode === 'low' ? 'Sort by price: low to high' : mode === 'high' ? 'Sort by price: high to low' : 'Sort by average rating'
    const what = mode === 'low' ? 'cheapest' : mode === 'high' ? 'most expensive' : 'best rated'
    const fact = mode === 'rating' ? `rated ${first.rating.toFixed(2)} out of 5` : money(mode === 'low' ? first.min : first.max)
    return {
      goal: rng.pick([`Which is the ${what} product in ${cat}?`, `In the ${cat} category, sort the list and tell me the ${what} item.`, `Find the ${what} ${cat.toLowerCase()} item in the shop.`]),
      start: `/product-category/${slug}/`,
      plan: [{ title: `Sort ${cat} by ${mode === 'rating' ? 'average rating' : `price, ${mode} first`}`, check: `url contains orderby=` }],
      steps: [{ plan: 1, do: 'select', target: { role: 'combobox', name: 'Shop order' }, value: option, settle: 2500 }],
      answer: `The ${what} item in ${cat} is ${first.title} (${fact}).`,
      verify: async ({ snapshot }) => {
        const i = snapshot.search(/heading "[^"]+" \[level=2\]/)
        return i >= 0 && new RegExp(`heading "${loose(first.title)}"`).test(snapshot.slice(i, i + 400))
      },
      writes: false
    }
  }

const tasks = {
  // S1: find a product with the search box and read its price.
  search_price: async ({ rng, sh }) => {
    for (let t = 0; t < 20; t++) {
      const p = rng.pick(simple(sh, 0))
      const words = p.title.split(' ').filter((w) => /^[A-Za-z][A-Za-z+-]*$/.test(w) && w.length > 2).slice(0, rng.int(2, 3))
      if (words.length < 2) continue
      const query = words.join(' ')
      const where = words.map((w) => `(post_title LIKE '%${w.replace(/'/g, "''")}%' OR post_content LIKE '%${w.replace(/'/g, "''")}%' OR post_excerpt LIKE '%${w.replace(/'/g, "''")}%')`).join(' AND ')
      const n = Number(sql(sh, `SELECT COUNT(*) FROM wp_posts WHERE post_type='product' AND post_status='publish' AND ${where}`)[0][0])
      if (n < 2 || n > 20) continue
      const price = money(p.min)
      return {
        goal: rng.pick([`What is the price of "${p.title}"? Search for it.`, `Search the shop for ${query} and tell me the price of ${p.title}.`, `How much does the ${p.title} cost?`]),
        start: '/',
        plan: [
          { title: `Search for ${query}`, check: `text "Search results"` },
          { title: `Open ${p.title}`, check: `heading "${p.title}"` }
        ],
        steps: [
          { plan: 1, do: 'type', target: { role: 'searchbox', name: 'Search for:' }, text: query },
          { plan: 1, do: 'press', key: 'Enter', settle: 2000 },
          { plan: 2, do: 'click', target: { role: 'link', name: nameRe(p.title, ' ') }, settle: 2000 }
        ],
        answer: `${p.title} costs ${price}.`,
        verify: async ({ snapshot }) => snapshot.includes(price) && Number(sql(sh, `SELECT min_price FROM wp_wc_product_meta_lookup WHERE product_id=${p.id}`)[0][0]) === p.min,
        writes: false
      }
    }
    return null
  },

  // S3: sort a category by price or rating and read the first item.
  category_sort: async (ctx) => { for (let t = 0; t < 10; t++) { const s = sortSpec(ctx); if (s) return s } return null },


  // A product's rating and review count (read).
  product_rating: async ({ rng, sh }) => {
    const p = rng.pick(products(sh).filter((x) => x.count > 0))
    return {
      goal: rng.pick([`What is the customer rating of ${p.title}?`, `How many reviews does ${p.title} have, and what is its rating?`, `Check the star rating of the ${p.title}.`]),
      start: productPath(p),
      plan: [{ title: `Open the reviews of ${p.title}`, check: `tab "Reviews (${p.count})" is selected` }],
      steps: [{ plan: 1, do: 'click', target: { role: 'tab', name: `Reviews (${p.count})` } }],
      answer: `${p.title} is rated ${p.rating.toFixed(2)} out of 5 from ${p.count} review${p.count > 1 ? 's' : ''}.`,
      verify: async () => Number(sql(sh, `SELECT rating_count FROM wp_wc_product_meta_lookup WHERE product_id=${p.id}`)[0][0]) === p.count,
      writes: false
    }
  },

  // S4/S5: add a simple product to the cart, from its page or from a category list.
  add_to_cart: async ({ rng, sh }) => {
    const p = rng.pick(simple(sh, 5))
    const qty = rng.chance(0.35) ? rng.int(2, 3) : 1
    const fromList = qty === 1 && rng.chance(0.4)
    if (fromList) {
      const page1 = products(sh).filter((x) => x.catSlug === p.catSlug).sort((a, b) => a.title.localeCompare(b.title, 'en')).slice(0, 18)
      if (!page1.includes(p)) return null
    }
    const steps = fromList
      ? [{ plan: 1, do: 'click', target: { role: 'button', name: new RegExp(`^Add to cart: .${loose(p.title)}.$`) }, settle: 2500 }]
      : [
          ...(qty > 1 ? [{ plan: 1, do: 'type', target: { role: 'spinbutton', name: 'Product quantity' }, text: String(qty) }] : []),
          { plan: 1, do: 'click', target: { role: 'button', name: 'Add to cart' }, settle: 2500 }
        ]
    return {
      goal: qty > 1 ? rng.pick([`Add ${qty} of ${p.title} to my cart.`, `Put ${qty} units of the ${p.title} in the cart.`]) : rng.pick([`Add ${p.title} to my cart.`, `Put the ${p.title} in my shopping cart.`, `I want to buy ${p.title}; add it to the cart.`]),
      start: fromList ? `/product-category/${p.catSlug}/` : productPath(p),
      plan: [{ title: `Add ${qty > 1 ? `${qty} × ` : ''}${p.title} to the cart`, check: fromList ? 'link "View cart"' : `text "has been added to your cart"` }],
      steps,
      answer: `Added ${qty > 1 ? `${qty} × ` : ''}${p.title} to the cart.`,
      verify: async () => cartLine(state(sh, 'cart'), p)?.quantity === qty
    }
  },

  // Add a size and colour variant of a clothing / footwear item.
  add_variant: async ({ rng, sh }) => {
    const p = rng.pick(products(sh).filter((x) => x.type === 'variable' && x.stock === 'instock'))
    const vars = sql(sh, `SELECT v.ID, s.meta_value, c.meta_value FROM wp_posts v JOIN wp_postmeta s ON s.post_id=v.ID AND s.meta_key='attribute_pa_size' JOIN wp_postmeta c ON c.post_id=v.ID AND c.meta_key='attribute_pa_colour' JOIN wp_postmeta st ON st.post_id=v.ID AND st.meta_key='_stock_status' AND st.meta_value='instock' WHERE v.post_parent=${p.id} AND v.post_type='product_variation'`)
    if (!vars.length) return null
    const [vid, sizeSlug, colSlug] = rng.pick(vars)
    const term = (tax, slug) => sql(sh, `SELECT t.name FROM wp_terms t JOIN wp_term_taxonomy tt ON tt.term_id=t.term_id WHERE tt.taxonomy='${tax}' AND t.slug='${slug}'`)[0][0]
    const size = term('pa_size', sizeSlug); const colour = term('pa_colour', colSlug)
    return {
      goal: rng.pick([`Add ${p.title} in size ${size}, colour ${colour}, to my cart.`, `I need the ${p.title} in ${colour}, size ${size}. Add it to the cart.`, `Put a size ${size} ${colour} ${p.title} in my cart.`]),
      start: productPath(p),
      plan: [
        { title: `Choose size ${size}`, check: `combobox "Size" = ${size}` },
        { title: `Choose colour ${colour}`, check: `combobox "Colour" = ${colour}` },
        { title: 'Add it to the cart', check: `text "has been added to your cart"` }
      ],
      steps: [
        { plan: 1, do: 'select', target: { role: 'combobox', name: 'Size' }, value: size },
        { plan: 2, do: 'select', target: { role: 'combobox', name: 'Colour' }, value: colour },
        { plan: 3, do: 'click', target: { role: 'button', name: 'Add to cart' }, settle: 2500 }
      ],
      answer: `Added ${p.title} (${size}, ${colour}) to the cart.`,
      verify: async () => state(sh, 'cart').items.some((i) => i.variation_id === Number(vid))
    }
  },

  // Change the quantity of a cart line with the + / − buttons.
  cart_quantity: async ({ rng, sh, page }) => {
    const p = rng.pick(simple(sh, 6))
    const start = rng.int(1, 3)
    await fillCart(page, [[p, start]])
    const have = cartLine(state(sh, 'cart'), p)?.quantity
    if (!have) return null
    const target = have === 1 ? rng.int(2, 3) : rng.chance(0.5) ? have - 1 : have + 1
    const n = Math.abs(target - have)
    const button = target > have ? 'Increase' : 'Reduce'
    return {
      goal: rng.pick([`Change the quantity of ${p.title} in my cart to ${target}.`, `I want ${target} of the ${p.title}; update the cart.`, `Set ${p.title} to ${target} in the cart.`]),
      start: '/cart/',
      plan: [{ title: `${button} the quantity of ${p.title} to ${target}`, check: `spinbutton "Quantity of ${p.title} in your cart." = ${target}` }],
      steps: Array.from({ length: n }, () => ({ plan: 1, do: 'click', target: { role: 'button', name: new RegExp(`^${button} quantity of ${loose(p.title)}$`) }, settle: 2000 })),
      answer: `${p.title} quantity is now ${target}.`,
      verify: async () => cartLine(state(sh, 'cart'), p)?.quantity === target
    }
  },

  // Remove one line from a two-line cart.
  cart_remove: async ({ rng, sh, page }) => {
    const [a, b] = rng.sample(simple(sh, 3), 2)
    await fillCart(page, [[a, 1], [b, 1]])
    if (!cartLine(state(sh, 'cart'), a)) return null
    return {
      goal: rng.pick([`Remove ${a.title} from my cart.`, `Take the ${a.title} out of the shopping cart.`, `I don't want ${a.title} any more; delete it from the cart.`]),
      start: '/cart/',
      plan: [{ title: `Remove ${a.title} from the cart`, check: `text "${a.title}" is gone from the cart` }],
      steps: [{ plan: 1, do: 'click', target: { role: 'button', name: new RegExp(`^Remove ${loose(a.title)} from cart$`) }, settle: 2500 }],
      answer: `Removed ${a.title} from the cart.`,
      verify: async () => !cartLine(state(sh, 'cart'), a)
    }
  },

  // A2-style: apply a coupon code in the cart.
  apply_coupon: async ({ rng, sh, page }) => {
    const coupons = [['SAVE10', 0], ['WELCOME15', 999], ['FESTIVE20', 2999], ['FLAT200', 1499], ['FLAT500', 4999], ['MONSOON12', 0], ['NEWUSER100', 499], ['DIWALI30', 9999]]
    const [code, min] = rng.pick(coupons)
    const p = rng.pick(simple(sh, 3).filter((x) => x.min >= min && x.catSlug !== 'books'))
    await fillCart(page, [[p, 1]])
    if (!cartLine(state(sh, 'cart'), p)) return null
    return {
      goal: rng.pick([`Apply the coupon ${code} to my cart.`, `Use discount code ${code} on my order.`, `I have a coupon, ${code}. Add it in the cart.`]),
      start: rng.chance(0.75) ? '/cart/' : '/checkout/',
      plan: [
        { title: 'Open the coupon field', check: 'textbox "Enter code"' },
        { title: `Enter ${code} and apply it`, check: `text "${code.toLowerCase()}"` }
      ],
      steps: [
        { plan: 1, do: 'click', target: { role: 'button', name: 'Add coupons' } },
        { plan: 2, do: 'type', target: { role: 'textbox', name: 'Enter code' }, text: code },
        { plan: 2, do: 'click', target: { role: 'button', name: 'Apply' }, settle: 2500 }
      ],
      answer: `Coupon ${code} is applied.`,
      verify: async () => state(sh, 'cart').coupons.map((c) => c.toLowerCase()).includes(code.toLowerCase())
    }
  },

  // Place an order with cash on delivery (our own clone: allowed).
  place_order: async ({ rng, sh, page }) => {
    const p = rng.pick(simple(sh, 3))
    await fillCart(page, [[p, 1]])
    if (!cartLine(state(sh, 'cart'), p)) return null
    const before = state(sh, 'orders')[0]?.id ?? 0
    const cod = rng.chance(0.8)
    return {
      goal: cod ? rng.pick([`Check out my cart and pay with cash on delivery.`, `Place the order for ${p.title}, cash on delivery.`, `Buy what is in my cart. I'll pay cash when it arrives.`]) : rng.pick([`Place my order and pay by cheque.`, `Check out the ${p.title} with the cheque payment option.`]),
      start: '/checkout/',
      startWait: 2500,
      plan: [
        ...(cod ? [{ title: 'Choose Cash on delivery', check: 'radio "Cash on delivery" is checked' }] : []),
        { title: 'Place the order', check: 'text "Order received"' }
      ],
      steps: [
        ...(cod ? [{ plan: 1, do: 'click', target: { role: 'radio', name: 'Cash on delivery' } }] : []),
        { plan: cod ? 2 : 1, do: 'click', target: { role: 'button', name: 'Place Order' }, settle: 5000 }
      ],
      answer: `Order placed for ${p.title}, ${cod ? 'cash on delivery' : 'pay by cheque'}.`,
      verify: async () => { const o = state(sh, 'orders')[0]; return o.id > before && o.payment === (cod ? 'cod' : 'cheque') && o.items.some((i) => i.product_id === p.id) },
      finalSettle: 1500
    }
  },

  // B4: read an order's status (or items) in My Account.
  order_status: async ({ rng, sh }) => {
    const orders = state(sh, 'orders').slice(0, 10)
    const o = rng.pick(orders)
    const items = o.items.map((i) => i.name)
    const viaDash = rng.chance(0.4)
    const askItems = rng.chance(0.35)
    return {
      goal: askItems ? rng.pick([`What did I buy in order #${o.number}?`, `List the items in my order ${o.number}.`]) : rng.pick([`What is the status of my order #${o.number}?`, `Has order ${o.number} been delivered? Check its status.`, `Track my order #${o.number}.`]),
      start: viaDash ? '/my-account/' : '/my-account/orders/',
      plan: [
        ...(viaDash ? [{ title: 'Open Orders', check: 'heading "Orders"' }] : []),
        { title: `Open order #${o.number}`, check: `text "Order #${o.number}"` }
      ],
      steps: [
        ...(viaDash ? [{ plan: 1, do: 'click', target: { role: 'link', name: /Orders$/, under: /navigation Account pages/ } }] : []),
        { plan: viaDash ? 2 : 1, do: 'click', target: { role: 'link', name: `View order number ${o.number}` } }
      ],
      answer: askItems ? `Order #${o.number} has: ${items.join('; ')}.` : `Order #${o.number} (placed ${o.created}) is ${o.status_name}.`,
      verify: async () => state(sh, 'orders').find((x) => x.id === o.id)?.status === o.status,
      writes: false
    }
  },

  // Write a product review with a star rating.
  write_review: async ({ rng, sh }) => {
    const p = rng.pick(products(sh))
    const stars = rng.pick([5, 5, 4, 4, 3, 2, 1])
    const text = rng.pick(stars >= 4 ? ['Really good, works as described.', 'Great quality for the price.', 'Delivery was quick and the product is excellent.', 'Very happy with it, would buy again.'] : stars === 3 ? ['It is okay, nothing special.', 'Average product, the packaging was damaged.'] : ['Stopped working within a week.', 'Not as described, quality is poor.']) + ` (${rng.int(10, 99)})`
    return {
      goal: rng.pick([`Write a ${stars}-star review for ${p.title}: "${text}"`, `Review the ${p.title}. Give it ${stars} stars and say: ${text}`, `Rate ${p.title} ${stars} out of 5 with the comment "${text}".`]),
      start: productPath(p),
      plan: [
        { title: 'Open the Reviews tab', check: 'text "Your rating"' },
        { title: `Pick ${stars} stars`, check: `radio "${stars} of 5 stars" is checked` },
        { title: 'Write the review text', check: `textbox "Your review *" = ${text}` },
        { title: 'Submit the review', check: `text "${text}"` }
      ],
      steps: [
        { plan: 1, do: 'click', target: { role: 'tab', name: /^Reviews \(/ } },
        { plan: 2, do: 'click', target: { role: 'radio', name: new RegExp(`${stars} of 5 stars$`) } },
        { plan: 3, do: 'type', target: { role: 'textbox', name: 'Your review *' }, text },
        { plan: 4, do: 'click', target: { role: 'button', name: 'Submit' }, settle: 3000 }
      ],
      answer: `Posted a ${stars}-star review on ${p.title}.`,
      verify: async () => sql(sh, `SELECT m.meta_value FROM wp_comments c JOIN wp_commentmeta m ON m.comment_id=c.comment_ID AND m.meta_key='rating' JOIN wp_users u ON u.ID=c.user_id WHERE c.comment_post_ID=${p.id} AND u.user_login='${USER}' AND c.comment_content='${text.replace(/'/g, "''")}'`)[0]?.[0] === String(stars)
    }
  },

  // Save a product to the wishlist.
  add_wishlist: async ({ rng, sh }) => {
    const p = rng.pick(products(sh))
    return {
      goal: rng.pick([`Save ${p.title} to my wishlist.`, `Add the ${p.title} to my wish list for later.`, `Put ${p.title} on my wishlist.`]),
      start: productPath(p),
      plan: [{ title: `Add ${p.title} to the wishlist`, check: 'text "Product added"' }],
      steps: [{ plan: 1, do: 'click', target: { role: 'button', name: 'Add to wishlist' }, settle: 2500 }],
      answer: `${p.title} is on your wishlist.`,
      verify: async () => state(sh, 'wishlist').includes(p.id)
    }
  },

  // Update the shipping or billing address in My Account.
  update_address: async ({ rng, sh }) => {
    const kind = rng.chance(0.7) ? 'shipping' : 'billing'
    const cur = state(sh, 'address')
    const street = `${rng.int(2, 240)}, ${rng.pick(['Koregaon Park Lane 5', 'Baner Road', 'Aundh Main Road', 'Senapati Bapat Road', 'Prabhat Road', 'Kalyani Nagar Road 2', 'Viman Nagar Street 7', 'Model Colony Lane 3'])}`
    const pin = `4110${String(rng.int(1, 62)).padStart(2, '0')}`
    const phone = `9${rng.int(100000000, 999999999)}`
    const changePhone = kind === 'billing' && rng.chance(0.5)
    const fields = changePhone ? [['Phone', phone, 'phone']] : [['Street address', street, 'address_1'], ['PIN Code', pin, 'postcode']]
    if (fields.every(([, v, k]) => cur[`${kind}_${k}`] === v)) return null
    return {
      goal: changePhone ? rng.pick([`Change the phone number on my billing address to ${phone}.`, `Update my billing phone to ${phone}.`])
        : rng.pick([`Update my ${kind} address to ${street}, Pune ${pin}.`, `I moved: change my ${kind} address street to "${street}" and the PIN code to ${pin}.`, `Edit the ${kind} address in my account: ${street}, PIN ${pin}.`]),
      start: `/my-account/edit-address/${kind}/`,
      plan: [
        ...fields.map(([label, v]) => ({ title: `Set ${label} to ${v}`, check: `textbox "${label}" = ${v}` })),
        { title: 'Save the address', check: 'text "Address changed successfully"' }
      ],
      steps: [
        ...fields.map(([label, v], i) => ({ plan: i + 1, do: 'type', target: { role: 'textbox', name: label === 'Phone' ? /^Phone/ : label }, text: v })),
        { plan: fields.length + 1, do: 'click', target: { role: 'button', name: 'Save address' }, settle: 2500 }
      ],
      answer: `Your ${kind} address is updated.`,
      verify: async () => { const a = state(sh, 'address'); return fields.every(([, v, k]) => a[`${kind}_${k}`] === v) }
    }
  }
}

export default {
  name: 'woo',
  family: 'shop',
  origin: ORIGIN,
  portOffset: 50,
  explorePaths: ['/', '/my-account/', '/product-category/headphones/', '/product-category/womens-clothing/', '/cart/', '/my-account/orders/'],
  async reset({ sh }) { sh('bash /workspace/action-data-gen/scripts/clones/farm/shop/reset.sh') },
  async login({ page, sleep }) {
    await page.context().clearCookies()
    await page.goto(`${ORIGIN}/my-account/`)
    await page.fill('#username', USER)
    await page.fill('#password', ACCOUNTS.password)
    await Promise.all([page.waitForURL(/my-account/, { timeout: 30_000 }), page.click('button[name=login]')])
    await page.waitForSelector('.woocommerce-MyAccount-navigation', { timeout: 30_000 })
    await sleep(500)
  },
  tasks
}
