// Consumer flows: the tasks people want a personal agent to do (shopping, flights, mail, social
// feeds). One shared engine: views in one page, cookie banners, autocomplete, date pickers,
// lists that load more on scroll, toggles (like, follow, add to cart, archive), reading values,
// and confirm/pay/send steps that need the user (takeover).
//
// A flow task is a list of steps. Each step names its view, its target (data-gen-id) and how to
// tell it is done. The label script walks the steps on the live page state.

import { createRng } from './rng.mjs'
import { DOMAINS, SITE_NAMES, FIRST_NAMES, LAST_NAMES } from './vocab-pools.mjs'
import { bookingFlow } from './flows-booking.mjs'
import { crmFlow } from './flows-crm.mjs'
import { calendarFlow } from './flows-calendar.mjs'
import { sheetFlow } from './flows-sheet.mjs'
import { ticketsFlow } from './flows-tickets.mjs'

export const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const q = (t) => JSON.stringify(String(t))
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1)

export const FLOW_FAMILIES = ['shop', 'flight', 'mail', 'feed', 'admin', 'research', 'booking', 'crm', 'calendar', 'sheet', 'tickets']

// Families in their own files (flows-<name>.mjs). Each gives spec, render, runtime and, where it
// needs them, its own action kinds, step tests and gate reasons. Read lazily: the files import
// helpers from here.
const moreFlow = (family) => ({ booking: bookingFlow, crm: crmFlow, calendar: calendarFlow, sheet: sheetFlow, tickets: ticketsFlow })[family]

const BRANDS = ['Nike', 'Puma', 'Adidas', 'Bata', 'Boat', 'Noise', 'Philips', 'Prestige', 'Milton', 'Wildcraft', 'Skybags', 'Titan']
const PRODUCTS = [
  ['running shoes', 'shoes'], ['sneakers', 'shoes'], ['wireless earbuds', 'audio'], ['headphones', 'audio'],
  ['smart watch', 'watch'], ['backpack', 'bags'], ['water bottle', 'kitchen'], ['pressure cooker', 'kitchen'],
  ['trekking jacket', 'clothing'], ['cotton t-shirt', 'clothing'], ['trimmer', 'grooming'], ['laptop bag', 'bags']
]
const SIZES = ['XS', 'S', 'M', 'L', 'XL']
const AIRPORTS = [['Pune', 'PNQ'], ['Mumbai', 'BOM'], ['Delhi', 'DEL'], ['Bengaluru', 'BLR'], ['Chennai', 'MAA'], ['Kolkata', 'CCU'], ['Hyderabad', 'HYD'], ['Goa', 'GOI'], ['Jaipur', 'JAI'], ['Kochi', 'COK']]
const AIRLINES = ['IndiGo', 'Air India', 'Akasa Air', 'SpiceJet', 'Vistara']
const TOPICS = ['cricket', 'startups', 'cooking', 'travel', 'AI', 'fitness', 'music', 'design']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

// ---------------------------------------------------------------- spec + task

export function generateFlow(seed, family) {
  const rng = createRng(`${seed}:flow`)
  const site = rng.int(0, DOMAINS.length - 1)
  let n = 0
  const id = (p) => `${p}${++n}`
  const base = {
    seed, flow: true, family, domain: DOMAINS[site], siteName: SITE_NAMES[site],
    theme: { accent: rng.pick(['#2563eb', '#16a34a', '#db2777', '#ea580c', '#7c3aed', '#0f766e']), font: rng.pick(['system-ui', 'Georgia, serif', 'Verdana, sans-serif', '"Helvetica Neue", Arial']), radius: rng.int(0, 14) },
    cookie: rng.chance(0.45) ? { id: id('ck'), rejectId: id('ck'), acceptId: id('ck') } : null,
    loginWall: rng.chance(0.08) ? { id: id('lw') } : null
  }
  const build = { shop: shopSpec, flight: flightSpec, mail: mailSpec, feed: feedSpec, admin: adminSpec, research: researchSpec }[family] ?? moreFlow(family).spec
  const { spec, task } = build(rng, base, id)
  return { spec, task, html: render(spec) }
}

function shopSpec(rng, base, id) {
  const items = Array.from({ length: rng.int(18, 48) }, () => {
    const [name, cat] = rng.pick(PRODUCTS)
    const brand = rng.pick(BRANDS)
    return { id: id('it'), viewId: id('iv'), name: `${brand} ${name}`, brand, cat, price: rng.int(4, 120) * 50, rating: (rng.int(30, 49) / 10).toFixed(1), reviews: rng.int(3, 4000), sizes: cat === 'shoes' || cat === 'clothing' ? rng.sample(SIZES, rng.int(2, 5)) : [] }
  })
  const searchTerm = rng.pick(items).name.split(' ').slice(1).join(' ')
  const matches = items.filter((i) => i.name.includes(searchTerm))
  const target = rng.pick(matches)
  const spec = {
    ...base, path: rng.pick(['/', '/home', '/store']), heading: base.siteName,
    searchId: id('s'), searchGoId: id('s'), sortId: id('so'), items, pageStep: rng.pick([6, 8, 12]),
    brandFilters: [...new Set(items.map((i) => i.brand))].slice(0, 6).map((b) => ({ id: id('bf'), brand: b })),
    sizeButtons: Object.fromEntries(items.map((i) => [i.id, i.sizes.map((s) => ({ id: id('sz'), size: s }))])),
    addId: id('add'), cartId: id('cart'), checkoutId: id('co'), backId: id('bk')
  }
  const kind = rng.pick(['price', 'price', 'add', 'cheapest', 'buy'])
  const steps = [...cookieSteps(spec), searchSteps(spec, searchTerm)]
  let goal, answer
  if (kind === 'cheapest') {
    const cheapest = [...matches].sort((a, b) => a.price - b.price)[0]
    steps.push({ title: 'Sort by price, low to high', check: 'results sorted by price', test: { type: 'value', id: spec.sortId, value: 'Price: low to high' }, view: 'results', action: { kind: 'select', id: spec.sortId, value: 'Price: low to high' } })
    goal = rng.pick([`What is the cheapest ${searchTerm} on ${base.siteName}?`, `Find the lowest-priced ${searchTerm}.`])
    answer = `${cheapest.name} ₹${cheapest.price}`
    return { spec, task: { family: 'shop', goal, steps, answer, done: { type: 'sortedVisible', id: cheapest.id } } }
  }
  if (kind === 'price') {
    goal = rng.pick([`How much does the ${target.name} cost?`, `Find the price of the ${target.name}.`, `Check the price of ${target.name} on ${base.siteName}.`])
    steps.push({ title: `Find ${target.name} in the results`, check: `card "${target.name}" is shown`, test: { type: 'visible', id: target.id }, view: 'results', action: { kind: 'reveal', id: target.id } })
    return { spec, task: { family: 'shop', goal, steps, answer: `₹${target.price}`, done: { type: 'visible', id: target.id } } }
  }
  const size = target.sizes.length ? rng.pick(target.sizes) : null
  steps.push({ title: `Open ${target.name}`, check: `product page "${target.name}"`, test: { type: 'view', view: `p-${target.id}` }, view: 'results', action: { kind: 'click', id: target.viewId, reveal: target.id } })
  if (size) {
    const btn = spec.sizeButtons[target.id].find((s) => s.size === size)
    steps.push({ title: `Choose size ${size}`, check: `size ${size} selected`, test: { type: 'picked', key: target.id, value: size }, view: `p-${target.id}`, action: { kind: 'click', id: btn.id } })
  }
  steps.push({ title: 'Add to cart', check: 'text "Added to cart"', test: { type: 'effect', key: `cart:${target.id}` }, view: `p-${target.id}`, action: { kind: 'click', id: spec.addId } })
  if (kind === 'buy') {
    steps.push({ title: 'Open the cart', check: 'cart is shown', test: { type: 'view', view: 'cart' }, view: `p-${target.id}`, action: { kind: 'click', id: spec.cartId } })
    steps.push({ title: 'Go to checkout', check: 'payment page', test: { type: 'gate', gate: 'payment' }, view: 'cart', action: { kind: 'click', id: spec.checkoutId } })
    goal = `Buy the ${target.name}${size ? ` in size ${size}` : ''}.`
    return { spec, task: { family: 'shop', goal, steps, answer: 'Order placed', done: { type: 'gatePassed', gate: 'payment' } } }
  }
  goal = rng.pick([`Add the ${target.name}${size ? ` in size ${size}` : ''} to my cart.`, `Put ${target.name}${size ? ` (${size})` : ''} in the cart.`])
  return { spec, task: { family: 'shop', goal, steps, answer: `Added ${target.name} to the cart`, done: { type: 'effect', key: `cart:${target.id}` } } }
}

function flightSpec(rng, base, id) {
  const [from, to] = rng.sample(AIRPORTS, 2)
  const day = rng.int(3, 27)
  const monthOffset = rng.chance(0.35) ? 1 : 0
  const month = (9 + monthOffset) % 12 // October 2026 is "this month"
  const flights = Array.from({ length: rng.int(10, 30) }, () => {
    const dep = rng.int(5, 22)
    return { id: id('fl'), selectId: id('fs'), airline: rng.pick(AIRLINES), dep: `${String(dep).padStart(2, '0')}:${rng.pick(['00', '15', '30', '45'])}`, stops: rng.chance(0.55) ? 0 : rng.int(1, 2), price: rng.int(25, 140) * 100 }
  })
  const spec = {
    ...base, path: rng.pick(['/', '/flights']), heading: `${base.siteName} Flights`,
    fromId: id('fr'), toId: id('to'), dateBtnId: id('dt'), monthNextId: id('mn'), paxId: id('px'), searchId: id('go'),
    airports: AIRPORTS, flights, dayIds: Object.fromEntries([9, 10].map((m) => [m, Array.from({ length: 31 }, (_, i) => id(`d${m}_${i + 1}_`))])),
    sortId: id('so'), nonstopId: id('ns'), payId: id('pay'), pageStep: rng.pick([6, 8, 10])
  }
  const dateLabel = `${day} ${MONTHS[month]} 2026`
  const steps = [
    ...cookieSteps(spec),
    { title: `Set From to ${from[0]}`, check: `From = ${from[0]} (${from[1]})`, test: { type: 'picked', key: spec.fromId, value: `${from[0]} (${from[1]})` }, view: 'home', action: { kind: 'autocomplete', id: spec.fromId, typed: from[0].slice(0, rng.int(3, from[0].length)), option: `${from[0]} (${from[1]})` } },
    { title: `Set To to ${to[0]}`, check: `To = ${to[0]} (${to[1]})`, test: { type: 'picked', key: spec.toId, value: `${to[0]} (${to[1]})` }, view: 'home', action: { kind: 'autocomplete', id: spec.toId, typed: to[0].slice(0, rng.int(3, to[0].length)), option: `${to[0]} (${to[1]})` } },
    { title: `Pick ${dateLabel}`, check: `date = ${dateLabel}`, test: { type: 'picked', key: spec.dateBtnId, value: dateLabel }, view: 'home', action: { kind: 'date', id: spec.dateBtnId, month, day } },
    { title: 'Search flights', check: 'flight results are shown', test: { type: 'view', view: 'results' }, view: 'home', action: { kind: 'click', id: spec.searchId } }
  ]
  const nonstop = rng.chance(0.5)
  if (nonstop) steps.push({ title: 'Show non-stop flights only', check: 'checkbox "Non-stop only" checked', test: { type: 'value', id: spec.nonstopId, value: true }, view: 'results', action: { kind: 'check', id: spec.nonstopId } })
  steps.push({ title: 'Sort by price, low to high', check: 'results sorted by price', test: { type: 'value', id: spec.sortId, value: 'Cheapest first' }, view: 'results', action: { kind: 'select', id: spec.sortId, value: 'Cheapest first' } })
  const pool = flights.filter((f) => !nonstop || f.stops === 0)
  const best = [...pool].sort((a, b) => a.price - b.price)[0]
  const book = rng.chance(0.3)
  const goal = `${book ? 'Book' : 'Find'} the cheapest ${nonstop ? 'non-stop ' : ''}flight from ${from[0]} to ${to[0]} on ${day} ${MONTHS[month]}${book ? '' : ' and tell me the airline and price'}.`
  // No non-stop flight in the pool: draw another spec before either branch reads `best`.
  if (!best) return flightSpec(rng, base, id)
  if (book) {
    steps.push({ title: `Select the ${best.airline} ${best.dep} flight`, check: 'payment page', test: { type: 'gate', gate: 'payment' }, view: 'results', action: { kind: 'click', id: best.selectId, reveal: best.id } })
    return { spec, task: { family: 'flight', goal, steps, answer: 'Booked', done: { type: 'gatePassed', gate: 'payment' }, nonstop } }
  }
  return { spec, task: { family: 'flight', goal, steps, answer: `${best.airline} ₹${best.price}`, done: { type: 'sortedVisible', id: best.id }, nonstop } }
}

function mailSpec(rng, base, id) {
  const senders = rng.sample(['Swiggy', 'Zomato', 'HDFC Bank', 'LinkedIn', 'Amazon', 'Myntra', 'Medium Daily', 'Product Hunt', 'Uber', 'Airtel', 'IRCTC', 'Notion'], 8)
  const people = Array.from({ length: 4 }, () => `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`)
  const mails = Array.from({ length: rng.int(14, 30) }, (_, i) => {
    const person = rng.chance(0.35)
    const from = person ? rng.pick(people) : rng.pick(senders)
    const topic = rng.pick(['invoice', 'offer', 'meeting', 'delivery', 'statement', 'weekly digest', 'trip', 'renewal'])
    return { id: id('m'), openId: id('mo'), boxId: id('mx'), replyId: id('rp'), bodyId: id('bd'), draftId: id('dr'), sendId: id('sd'), unsubId: id('un'), from, newsletter: !person, subject: `${cap(topic)} ${person ? 'for Thursday' : 'from ' + from}`, body: person ? `Hi, can we move the ${topic} to ${rng.pick(['3 pm', '11 am', 'Friday', 'next week'])}?` : `Your ${topic} is ready. ${rng.chance(0.5) ? 'Save 20% this week.' : 'View it online.'}`, unread: rng.chance(0.4), order: i }
  })
  const spec = { ...base, path: rng.pick(['/mail', '/inbox']), heading: 'Inbox', mails, archiveId: id('ar'), searchId: id('s'), unsubConfirmId: id('uc'), backId: id('bk'), pageStep: rng.pick([10, 12, 15]) }
  const kind = rng.pick(['archive', 'unsubscribe', 'draft', 'read'])
  const steps = [...cookieSteps(spec)]
  if (kind === 'archive') {
    const sender = rng.pick(mails.filter((m) => m.newsletter)).from
    const targets = mails.filter((m) => m.from === sender)
    for (const m of targets) steps.push({ title: `Select the mail "${m.subject}"`, check: `checkbox for "${m.subject}" checked`, test: { type: 'value', id: m.boxId, value: true }, view: 'inbox', action: { kind: 'check', id: m.boxId, reveal: m.id }, group: 'select' })
    steps.push({ title: 'Archive the selected mails', check: `no mail from ${sender} in the inbox`, test: { type: 'effect', key: `archived:${sender}` }, view: 'inbox', action: { kind: 'click', id: spec.archiveId } })
    return { spec, task: { family: 'mail', goal: rng.pick([`Archive every email from ${sender}.`, `Clear out all ${sender} mails from my inbox.`]), steps, answer: `Archived ${targets.length} emails from ${sender}`, done: { type: 'effect', key: `archived:${sender}` } } }
  }
  const m = kind === 'unsubscribe' ? rng.pick(mails.filter((x) => x.newsletter)) : rng.pick(mails.filter((x) => !x.newsletter).concat(mails.slice(0, 1)))
  steps.push({ title: `Open the mail from ${m.from}`, check: `subject "${m.subject}" is shown`, test: { type: 'view', view: `m-${m.id}` }, view: 'inbox', action: { kind: 'click', id: m.openId, reveal: m.id } })
  if (kind === 'unsubscribe') {
    steps.push({ title: 'Click Unsubscribe', check: 'unsubscribe page', test: { type: 'view', view: 'unsub' }, view: `m-${m.id}`, action: { kind: 'click', id: m.unsubId } })
    steps.push({ title: 'Confirm unsubscribe', check: 'text "You are unsubscribed"', test: { type: 'effect', key: `unsub:${m.from}` }, view: 'unsub', action: { kind: 'click', id: spec.unsubConfirmId } })
    return { spec, task: { family: 'mail', goal: `Unsubscribe me from ${m.from} emails.`, steps, answer: `Unsubscribed from ${m.from}`, done: { type: 'effect', key: `unsub:${m.from}` } } }
  }
  if (kind === 'draft') {
    const text = rng.pick(['Sounds good, see you then.', 'That works for me.', 'Can we keep the original time?', 'Thanks, confirming Friday.'])
    steps.push({ title: 'Click Reply', check: 'reply box is shown', test: { type: 'visible', id: m.bodyId }, view: `m-${m.id}`, action: { kind: 'click', id: m.replyId } })
    steps.push({ title: 'Type the reply', check: `reply text = ${text}`, test: { type: 'value', id: m.bodyId, value: text }, view: `m-${m.id}`, action: { kind: 'type', id: m.bodyId, value: text } })
    steps.push({ title: 'Save as draft', check: 'text "Draft saved"', test: { type: 'effect', key: 'draft' }, view: `m-${m.id}`, action: { kind: 'click', id: m.draftId } })
    return { spec, task: { family: 'mail', goal: `Draft a reply to ${m.from} saying "${text}" but don't send it.`, steps, answer: 'Draft saved', done: { type: 'effect', key: 'draft' } } }
  }
  return { spec, task: { family: 'mail', goal: `What did ${m.from} write in the mail "${m.subject}"?`, steps, answer: m.body.slice(0, 30), done: { type: 'view', view: `m-${m.id}` } } }
}

function feedSpec(rng, base, id) {
  const authors = Array.from({ length: 10 }, () => ({ name: `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`, followId: id('fo') }))
  const posts = Array.from({ length: rng.int(20, 45) }, () => {
    const a = rng.pick(authors)
    const topic = rng.pick(TOPICS)
    return { id: id('p'), likeId: id('lk'), author: a.name, followId: a.followId, topic, text: `${rng.pick(['Loved', 'Thoughts on', 'Big news in', 'A quick tip on', 'Weekend plans:'])} ${topic} — ${rng.pick(['what do you think?', 'thread below.', 'worth a read.', 'try this.'])} #${topic.replace(/\s/g, '')}` }
  })
  const spec = { ...base, path: rng.pick(['/home', '/feed', '/']), heading: 'Home', posts, authors, pageStep: rng.pick([5, 6, 8]), searchId: id('s') }
  const kind = rng.pick(['like', 'like', 'follow'])
  const steps = [...cookieSteps(spec)]
  if (kind === 'like') {
    const topic = rng.pick([...new Set(posts.map((p) => p.topic))])
    const want = Math.min(rng.int(2, 4), posts.filter((p) => p.topic === topic).length)
    const targets = posts.filter((p) => p.topic === topic).slice(0, want)
    for (const p of targets) steps.push({ title: `Like ${p.author}'s post about ${topic}`, check: `like button on "${p.text.slice(0, 30)}…" pressed`, test: { type: 'effect', key: `like:${p.id}` }, view: 'feed', action: { kind: 'click', id: p.likeId, reveal: p.id }, group: 'like' })
    return { spec, task: { family: 'feed', goal: `Like the first ${want} posts about ${topic} in my feed, and nothing else.`, steps, answer: `Liked ${want} posts about ${topic}`, done: { type: 'effects', keys: targets.map((p) => `like:${p.id}`) } } }
  }
  const p = rng.pick(posts)
  steps.push({ title: `Follow ${p.author}`, check: `button "Following" on ${p.author}`, test: { type: 'effect', key: `follow:${p.followId}` }, view: 'feed', action: { kind: 'click', id: p.followId, reveal: p.id } })
  return { spec, task: { family: 'feed', goal: `Follow ${p.author}.`, steps, answer: `Following ${p.author}`, done: { type: 'effect', key: `follow:${p.followId}` } } }
}


// SaaS admin (RevenueCat / Stripe style): products, prices, coupons.
function adminSpec(rng, base, id) {
  const products = Array.from({ length: rng.int(3, 9) }, () => ({ id: id('pr'), editId: id('pe'), delId: id('pd'), name: rng.pick(['Pro', 'Plus', 'Team', 'Starter', 'Business', 'Lifetime', 'Family', 'Student']) + ' ' + rng.pick(['Monthly', 'Yearly', 'Plan', 'Access', 'Pass']), price: rng.int(2, 60) * 100 - 1, currency: rng.pick(['INR', 'USD']), interval: rng.pick(['Monthly', 'Yearly', 'Lifetime']) }))
  const names = new Set(); for (const p of products) { while (names.has(p.name)) p.name += ' 2'; names.add(p.name) }
  const app = rng.pick(['Off Grid', 'Pinecrest', 'Quill', 'Orbit', 'Lumen'])
  const spec = {
    ...base, path: rng.pick(['/dashboard', '/projects/app', '/console']), heading: `${base.siteName} Dashboard`, app,
    nav: ['Overview', 'Products', 'Coupons', 'Customers', 'Settings'].map((label) => ({ id: id('nv'), label, view: label.toLowerCase() })),
    products, createId: id('cp'), couponCreateId: id('cc'),
    form: { nameId: id('fn'), priceId: id('fp'), currencyId: id('fc'), intervalIds: Object.fromEntries(['Monthly', 'Yearly', 'Lifetime'].map((k) => [k, id('fi')])), saveId: id('fs') },
    edit: { priceId: id('ep'), saveId: id('es') }, dialog: { confirmId: id('dc'), cancelId: id('dx') },
    coupon: { codeId: id('kc'), pctId: id('kp'), durationId: id('kd'), saveId: id('ks') }, backId: id('bk')
  }
  const kind = rng.pick(['create', 'create', 'edit', 'coupon', 'delete'])
  const steps = [...cookieSteps(spec)]
  const navTo = (view) => { const n = spec.nav.find((x) => x.view === view); return { title: `Open ${n.label}`, check: `${n.label} page is shown`, test: { type: 'view', view }, view: '*', action: { kind: 'click', id: n.id } } }
  if (kind === 'create') {
    const name = `${app} ${rng.pick(['Pro', 'Premium', 'Plus', 'Max'])} ${rng.pick(['Monthly', 'Yearly', 'Lifetime'])}`
    const price = String(rng.int(1, 80) * 100 - 1); const currency = rng.pick(['INR', 'USD']); const interval = rng.pick(['Monthly', 'Yearly', 'Lifetime'])
    steps.push(navTo('products'))
    steps.push({ title: 'Click Create product', check: 'new product form', test: { type: 'view', view: 'new-product' }, view: 'products', action: { kind: 'click', id: spec.createId } })
    steps.push({ title: `Set name to ${name}`, check: `textbox "Product name" = ${name}`, test: { type: 'value', id: spec.form.nameId, value: name }, view: 'new-product', action: { kind: 'type', id: spec.form.nameId, value: name } })
    steps.push({ title: `Set price to ${price}`, check: `textbox "Price" = ${price}`, test: { type: 'value', id: spec.form.priceId, value: price }, view: 'new-product', action: { kind: 'type', id: spec.form.priceId, value: price } })
    steps.push({ title: `Set currency to ${currency}`, check: `combobox "Currency" = ${currency}`, test: { type: 'value', id: spec.form.currencyId, value: currency }, view: 'new-product', action: { kind: 'select', id: spec.form.currencyId, value: currency } })
    steps.push({ title: `Choose ${interval} billing`, check: `radio "${interval}" checked`, test: { type: 'value', id: spec.form.intervalIds[interval], value: true }, view: 'new-product', action: { kind: 'check', id: spec.form.intervalIds[interval] } })
    steps.push({ title: 'Save the product', check: `text "Product created"`, test: { type: 'effect', key: `created:${name}` }, view: 'new-product', action: { kind: 'click', id: spec.form.saveId } })
    const goal = rng.pick([`Create a new ${interval.toLowerCase()} product called "${name}" priced at ${price} ${currency}.`, `On ${base.siteName}, add a product "${name}": ${currency} ${price}, ${interval.toLowerCase()} billing.`])
    return { spec, task: { family: 'admin', goal, steps, answer: `Created ${name}`, done: { type: 'effect', key: `created:${name}` } } }
  }
  if (kind === 'edit') {
    const p = rng.pick(products); const price = String(rng.int(1, 80) * 100 - 1)
    steps.push(navTo('products'))
    steps.push({ title: `Edit ${p.name}`, check: `edit form for ${p.name}`, test: { type: 'view', view: `edit-${p.id}` }, view: 'products', action: { kind: 'click', id: p.editId } })
    steps.push({ title: `Set the price to ${price}`, check: `textbox "Price" = ${price}`, test: { type: 'value', id: `${spec.edit.priceId}-${p.id}`, value: price }, view: `edit-${p.id}`, action: { kind: 'type', id: `${spec.edit.priceId}-${p.id}`, value: price } })
    steps.push({ title: 'Save changes', check: 'confirm dialog', test: { type: 'dialogOrEffect', key: `updated:${p.id}` }, view: `edit-${p.id}`, action: { kind: 'click', id: `${spec.edit.saveId}-${p.id}` } })
    steps.push({ title: 'Confirm the price change', check: 'text "Price updated"', test: { type: 'effect', key: `updated:${p.id}` }, view: `edit-${p.id}`, action: { kind: 'click', id: spec.dialog.confirmId } })
    return { spec, task: { family: 'admin', goal: `Change the price of ${p.name} to ${price} ${p.currency}.`, steps, answer: `${p.name} now costs ${price} ${p.currency}`, done: { type: 'effect', key: `updated:${p.id}` } } }
  }
  if (kind === 'coupon') {
    const code = rng.pick(['LAUNCH', 'DIWALI', 'WELCOME', 'STUDENT', 'EARLY']) + rng.int(10, 99); const pct = String(rng.pick([10, 15, 20, 25, 30, 50])); const duration = rng.pick(['Once', 'Repeating', 'Forever'])
    steps.push(navTo('coupons'))
    steps.push({ title: 'Click Create coupon', check: 'new coupon form', test: { type: 'view', view: 'new-coupon' }, view: 'coupons', action: { kind: 'click', id: spec.couponCreateId } })
    steps.push({ title: `Set code to ${code}`, check: `textbox "Code" = ${code}`, test: { type: 'value', id: spec.coupon.codeId, value: code }, view: 'new-coupon', action: { kind: 'type', id: spec.coupon.codeId, value: code } })
    steps.push({ title: `Set ${pct}% off`, check: `textbox "Percent off" = ${pct}`, test: { type: 'value', id: spec.coupon.pctId, value: pct }, view: 'new-coupon', action: { kind: 'type', id: spec.coupon.pctId, value: pct } })
    steps.push({ title: `Set duration to ${duration}`, check: `combobox "Duration" = ${duration}`, test: { type: 'value', id: spec.coupon.durationId, value: duration }, view: 'new-coupon', action: { kind: 'select', id: spec.coupon.durationId, value: duration } })
    steps.push({ title: 'Save the coupon', check: 'text "Coupon created"', test: { type: 'effect', key: `coupon:${code}` }, view: 'new-coupon', action: { kind: 'click', id: spec.coupon.saveId } })
    return { spec, task: { family: 'admin', goal: `Create a coupon ${code} for ${pct}% off, duration ${duration.toLowerCase()}.`, steps, answer: `Coupon ${code} created`, done: { type: 'effect', key: `coupon:${code}` } } }
  }
  const p = rng.pick(products)
  steps.push(navTo('products'))
  steps.push({ title: `Delete ${p.name}`, check: 'delete confirmation', test: { type: 'gate', gate: 'delete' }, view: 'products', action: { kind: 'click', id: p.delId } })
  return { spec, task: { family: 'admin', goal: `Delete the product ${p.name}.`, steps, answer: `${p.name} deleted`, done: { type: 'gatePassed', gate: 'delete' } } }
}

// Social research (X / LinkedIn style search): search, date filter, Top vs Latest, report.
function researchSpec(rng, base, id) {
  const subjects = ['AI agents', 'Off Grid AI', 'local LLMs', 'Mac mini', 'open source', 'RAG', 'fintech India', 'UPI', 'startup funding', 'GPU prices']
  const authors = Array.from({ length: 14 }, () => `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}`)
  const posts = Array.from({ length: rng.int(25, 50) }, () => {
    const subject = rng.pick(subjects)
    return { id: id('rp'), author: rng.pick(authors), subject, ageHours: rng.pick([1, 3, 8, 20, 30, 50, 90, 150, 300, 600]), likes: rng.int(0, 5000), text: `${rng.pick(['Hot take on', 'Thread: what I learned about', 'New benchmark for', 'Why everyone is talking about', 'My notes on'])} ${subject}` }
  })
  const spec = { ...base, path: rng.pick(['/search', '/explore']), heading: 'Search', posts, searchId: id('s'), searchGoId: id('sg'), dateId: id('df'), topId: id('tt'), latestId: id('tl'), pageStep: rng.pick([6, 8, 10]) }
  const subject = rng.pick([...new Set(posts.map((p) => p.subject))])
  const window_ = rng.pick([['Past 24 hours', 24], ['Past week', 168], ['Past month', 720]])
  const pool = posts.filter((p) => p.subject === subject && p.ageHours <= window_[1]).sort((a, b) => b.likes - a.likes)
  if (pool.length < 1) return researchSpec(rng, base, id)
  const steps = [...cookieSteps(spec),
    { title: `Search for ${subject}`, check: `results for "${subject}"`, test: { type: 'searched', value: subject }, view: '*', action: { kind: 'search', id: spec.searchId, go: spec.searchGoId, value: subject } },
    { title: `Filter to ${window_[0]}`, check: `combobox "Date" = ${window_[0]}`, test: { type: 'value', id: spec.dateId, value: window_[0] }, view: 'results', action: { kind: 'select', id: spec.dateId, value: window_[0] } },
    { title: 'Switch to Top posts', check: 'tab "Top" selected', test: { type: 'picked', key: 'tab', value: 'top' }, view: 'results', action: { kind: 'click', id: spec.topId } }]
  const three = pool.length >= 3 && rng.chance(0.4)
  const answer = three ? pool.slice(0, 3).map((p) => p.author).join(', ') : `${pool[0].author}`
  const goal = three
    ? `List the authors of the top 3 posts about ${subject} from the ${window_[0].toLowerCase()}.`
    : rng.pick([`Find the most-liked post about ${subject} from the ${window_[0].toLowerCase()} and tell me who posted it.`, `Who wrote the top post on ${subject} in the ${window_[0].toLowerCase()}?`])
  return { spec, task: { family: 'research', goal, steps, answer, done: { type: 'sortedVisible', id: pool[0].id } } }
}

function cookieSteps(spec) {
  const out = []
  if (spec.loginWall) out.push({ title: 'Sign in', check: 'the site is shown', test: { type: 'gatePassed', gate: 'login' }, view: '*', action: { kind: 'none' } })
  if (spec.cookie) out.push({ title: 'Close the cookie banner', check: 'no cookie banner', test: { type: 'cookieGone' }, view: '*', action: { kind: 'cookie' } })
  return out
}

function searchSteps(spec, term) {
  return { title: `Search for ${term}`, check: `results for "${term}"`, test: { type: 'searched', value: term }, view: 'home', action: { kind: 'search', id: spec.searchId, go: spec.searchGoId, value: term } }
}

// ---------------------------------------------------------------- label script

export function flowStepDone(step, state) {
  const t = step.test
  switch (t.type) {
    case 'value': return state.values[t.id] === t.value
    case 'visible': return state.visible.includes(t.id)
    case 'view': return state.view === t.view || state.history.includes(t.view)
    case 'picked': return state.picked[t.key] === t.value
    case 'effect': return Boolean(state.effects[t.key])
    case 'gate': return state.gate === t.gate || state.gatesPassed.includes(t.gate)
    case 'gatePassed': return state.gatesPassed.includes(t.gate) || !state.gate
    case 'cookieGone': return !state.cookieOpen
    case 'searched': return state.query === t.value.toLowerCase()
    case 'undo': return !state.effects[t.key]
    case 'dialogOrEffect': return state.dialogOpen || Boolean(state.effects[t.key])
    default: return moreFlow(state.family)?.done?.(t, state) ?? false
  }
}

function goalDone(task, state) {
  const d = task.done
  switch (d.type) {
    case 'visible': return state.view === 'results' && state.visible.includes(d.id)
    case 'sortedVisible': return state.view === 'results' && state.firstResult === d.id && task.steps.every((s) => flowStepDone(s, state))
    case 'effect': return Boolean(state.effects[d.key])
    case 'effects': return d.keys.every((k) => state.effects[k])
    case 'view': return state.view === d.view
    case 'gatePassed': return state.gatesPassed.includes(d.gate)
    default: return moreFlow(state.family)?.done?.(d, state) ?? false
  }
}

const GATE_REASON = { payment: 'payment details needed', login: 'sign in required', delete: 'confirm the deletion', send: 'confirm before sending' }

export function flowPlan(task) {
  return task.steps.map(({ title, check, test }) => ({ title, check, test }))
}

/** Unwanted effects the agent caused: liking or following the wrong thing. */
function flowIssues(task, state) {
  const wanted = new Set(task.steps.map((s) => s.test.key).filter(Boolean))
  return Object.keys(state.effects).filter((k) => state.effects[k] && (k.startsWith('like:') || k.startsWith('follow:')) && !wanted.has(k))
}

export function flowVerdict(task, plan, state) {
  if (state.gate) return { verdict: `takeover(${q(GATE_REASON[state.gate] ?? moreFlow(state.family)?.gates?.[state.gate] ?? 'the user must act')})` }
  if (goalDone(task, state)) return { verdict: `success(${q(task.answer)})` }
  // The goal cannot be met (the only time the user accepts is full): end once that is on screen.
  if (task.failWhen && flowStepDone({ test: task.failWhen }, state)) return { verdict: `fail(${q(task.failReason)})` }
  const extra = flowIssues(task, state)
  if (extra.length && !plan.some((s) => s.title.startsWith('Undo'))) return { verdict: `replan(${q('acted on the wrong item')})`, reason: 'acted on the wrong item' }
  const current = plan.findIndex((s) => !flowStepDone(s, state)) + 1
  if (current === 0) return { verdict: 'replan("the plan is finished but the goal is not met")', reason: 'the plan is finished but the goal is not met' }
  return { verdict: `continue(${current})`, current }
}

export function flowReplan(task, plan, state) {
  const done = plan.filter((s) => flowStepDone(s, state))
  const undo = flowIssues(task, state).map((key) => ({ title: 'Undo the extra ' + key.split(':')[0], check: 'only the wanted items are marked', test: { type: 'undo', key } }))
  const fresh = flowPlan(task).filter((s) => !flowStepDone(s, state) && !done.some((d) => JSON.stringify(d.test) === JSON.stringify(s.test)))
  return { done, remaining: [...undo, ...fresh] }
}

/** Every correct next action. `@id` is a data-gen-id target. */
export function flowActions(spec, task, state) {
  if (state.cookieOpen) return [`click(@${spec.cookie.rejectId})`, `click(@${spec.cookie.acceptId})`]
  const extra = flowIssues(task, state)
  if (extra.length) return [`click(@${state.effectTargets[extra[0]]})`]
  const step = task.steps.find((s) => !flowStepDone(s, state))
  if (!step) return []
  if (step.view !== '*' && step.view !== state.view && !(step.view === 'results' && state.view === 'results')) {
    // Wrong screen: go back toward the step's view.
    if (state.history.length > 1) return ['back()', `click(@${spec.backId ?? 'back'})`].filter((a) => !a.includes('undefined'))
  }
  const a = step.action
  const visible = new Set(state.visible)
  const revealFirst = () => (a.reveal && !visible.has(a.reveal) && !state.present.includes(a.reveal) ? ['scroll_down()'] : null)
  switch (a.kind) {
    case 'cookie': case 'none': return []
    case 'search': {
      const typed = String(state.values[a.id] ?? '')
      if (typed.toLowerCase() !== a.value.toLowerCase()) return [`type(@${a.id},${q(a.value)})`]
      return state.focused === a.id ? ['press("Enter")', `click(@${a.go})`] : [`click(@${a.go})`]
    }
    case 'autocomplete': {
      if (state.acOpen === a.id && state.acOptions[a.option]) return [`click(@${state.acOptions[a.option]})`]
      return [`type(@${a.id},${q(a.typed)})`]
    }
    case 'date': {
      if (!state.dpOpen) return [`click(@${a.id})`]
      if (state.dpMonth < a.month) return [`click(@${spec.monthNextId})`]
      return [`click(@${spec.dayIds[a.month][a.day - 1]})`]
    }
    case 'select': return [`select(@${a.id},${q(a.value)})`]
    case 'check': return revealFirst() ?? [`check(@${a.id})`, `click(@${a.id})`]
    case 'type': return [`type(@${a.id},${q(a.value)})`]
    case 'reveal': return revealFirst() ?? []
    case 'click': return revealFirst() ?? [`click(@${a.id})`]
    default: return moreFlow(spec.family)?.actions?.(spec, a, state) ?? []
  }
}

// ---------------------------------------------------------------- HTML + runtime

function render(spec) {
  const t = spec.theme
  const more = moreFlow(spec.family)
  const css = `
  body{margin:0;font-family:${t.font};background:#fff;color:#111}
  header{display:flex;gap:14px;align-items:center;padding:10px 18px;border-bottom:1px solid #ddd;position:sticky;top:0;background:#fff;z-index:2}
  main{max-width:1100px;margin:16px auto;padding:0 14px}
  button{padding:7px 12px;border:1px solid ${t.accent};border-radius:${t.radius}px;background:${t.accent};color:#fff;font:inherit;cursor:pointer}
  button.ghost{background:#fff;color:${t.accent}} button[aria-pressed=true]{background:#111;color:#fff}
  input,select,textarea{padding:8px;border:1px solid #999;border-radius:${t.radius}px;font:inherit}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px}
  .card{border:1px solid #ddd;border-radius:${t.radius}px;padding:12px;min-height:160px}
  .row{display:flex;gap:10px;align-items:center;border-bottom:1px solid #eee;padding:10px 4px}
  .banner{position:fixed;left:0;right:0;bottom:0;background:#222;color:#fff;padding:16px;display:flex;gap:10px;align-items:center;z-index:5}
  .list{position:absolute;background:#fff;border:1px solid #ccc;z-index:4;display:flex;flex-direction:column}
  .cal{display:grid;grid-template-columns:repeat(7,40px);gap:4px;padding:8px;border:1px solid #ccc;background:#fff}
  .wall{position:fixed;inset:0;background:#fffe;display:flex;align-items:center;justify-content:center;z-index:9}
  [hidden]{display:none!important}${more?.css ?? ''}`
  const body = ({ shop: renderShop, flight: renderFlight, mail: renderMail, feed: renderFeed, admin: renderAdmin, research: renderResearch }[spec.family] ?? more.render)(spec)
  const cookie = spec.cookie ? `<div class="banner" role="dialog" aria-label="Cookie consent" data-cookie><span>We use cookies to improve your experience.</span><button class="ghost" data-gen-id="${spec.cookie.rejectId}" data-cookie-btn="rejected">Reject all</button><button data-gen-id="${spec.cookie.acceptId}" data-cookie-btn="accepted">Accept all</button></div>` : ''
  const wall = spec.loginWall ? `<div class="wall" data-wall><div><h2>Log in to continue</h2><label>Email <input type="email"></label> <label>Password <input type="password"></label> <button>Log in</button></div></div>` : ''
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(spec.heading)} – ${esc(spec.siteName)}</title><style>${css}</style></head><body>
<header><strong>${esc(spec.siteName)}</strong>${spec.backId ? `<button class="ghost" data-gen-id="${spec.backId}" data-back aria-label="Back">←</button>` : ''}${body.header ?? ''}</header>
<main>${body.views}</main>${cookie}${wall}
<p role="status" id="status"></p>
<script>window.__SPEC=${JSON.stringify(spec).replace(/</g, '\\u003c')};${RUNTIME}${more?.runtime ?? ''}</script></body></html>`
}

function renderShop(spec) {
  const card = (i) => `<article class="card" data-gen-id="${i.id}" data-item data-price="${i.price}" data-brand="${esc(i.brand)}" data-name="${esc(i.name.toLowerCase())}"><h3>${esc(i.name)}</h3><p>₹${i.price.toLocaleString('en-IN')}</p><p>${i.rating} ★ (${i.reviews.toLocaleString('en-IN')})</p><a href="#" data-gen-id="${i.viewId}" data-goto="p-${i.id}">View details</a></article>`
  const product = (i) => `<section data-view="p-${i.id}" hidden><h1>${esc(i.name)}</h1><p>₹${i.price.toLocaleString('en-IN')} · ${i.rating} ★</p>
    ${spec.sizeButtons[i.id].length ? `<div role="group" aria-label="Size">${spec.sizeButtons[i.id].map((s) => `<button class="ghost" data-gen-id="${s.id}" data-pick-key="${i.id}" data-pick-value="${s.size}" aria-pressed="false">${s.size}</button>`).join(' ')}</div>` : ''}
    <p><button data-gen-id="${spec.addId}" data-add="${i.id}">Add to cart</button> <button class="ghost" data-gen-id="${spec.cartId}" data-goto="cart">Go to cart</button></p></section>`
  return {
    header: `<input type="search" aria-label="Search for products" placeholder="Search for products, brands and more" data-gen-id="${spec.searchId}" data-search> <button data-gen-id="${spec.searchGoId}" data-search-go aria-label="Search">Search</button>`,
    views: `<section data-view="home"><h1>Top picks for you</h1><div class="grid">${['Shoes', 'Audio', 'Kitchen', 'Bags', 'Clothing', 'Watches'].map((c) => `<div class="card"><h3>${c}</h3><p>Up to ${[30, 40, 50, 60][c.length % 4]}% off</p></div>`).join('')}</div></section>
    <section data-view="results" hidden><h1 id="results-title">Results</h1>
      <div style="display:flex;gap:16px"><aside><h3>Brand</h3>${spec.brandFilters.map((b) => `<label><input type="checkbox" data-gen-id="${b.id}" data-filter-brand="${esc(b.brand)}"> ${esc(b.brand)}</label><br>`).join('')}</aside>
      <div style="flex:1"><label>Sort by <select data-gen-id="${spec.sortId}" data-sort><option>Relevance</option><option>Price: low to high</option><option>Price: high to low</option><option>Customer rating</option></select></label>
      <div class="grid" data-lazy>${spec.items.map(card).join('')}</div><p data-lazy-more>Loading more…</p></div></div></section>
    ${spec.items.map(product).join('')}
    <section data-view="cart" hidden><h1>Your cart</h1><div id="cart-lines"></div><button data-gen-id="${spec.checkoutId}" data-gate="payment">Proceed to checkout</button></section>
    <section data-view="gate-payment" hidden><h1>Payment</h1><label>Card number <input autocomplete="cc-number"></label></section>`
  }
}

function renderFlight(spec) {
  const days = (m) => `<div class="cal" data-month="${m}" ${m === 9 ? '' : 'hidden'}><strong style="grid-column:span 7">${MONTHS[m]} 2026</strong>${spec.dayIds[m].map((d, i) => `<button class="ghost" data-gen-id="${d}" data-day="${i + 1} ${MONTHS[m]} 2026" aria-label="${i + 1} ${MONTHS[m]} 2026">${i + 1}</button>`).join('')}</div>`
  const flight = (f) => `<div class="row" data-gen-id="${f.id}" data-item data-price="${f.price}" data-stops="${f.stops}"><strong>${f.airline}</strong><span>Departs ${f.dep}</span><span>${f.stops === 0 ? 'Non-stop' : `${f.stops} stop${f.stops > 1 ? 's' : ''}`}</span><span>₹${f.price.toLocaleString('en-IN')}</span><button data-gen-id="${f.selectId}" data-gate="payment" aria-label="Select ${f.airline} ${f.dep}">Select</button></div>`
  const ac = (inputId, label) => `<label>${label} <input data-gen-id="${inputId}" data-ac aria-label="${label}" autocomplete="off" placeholder="City or airport"></label><div class="list" role="listbox" aria-label="${label} suggestions" data-ac-list="${inputId}" hidden></div>`
  return {
    views: `<section data-view="home"><h1>Search flights</h1><div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start">${ac(spec.fromId, 'From')} ${ac(spec.toId, 'To')}
      <div><button class="ghost" data-gen-id="${spec.dateBtnId}" data-dp aria-label="Departure date">Departure date</button><div data-dp-panel hidden>${days(9)}${days(10)}<button class="ghost" data-gen-id="${spec.monthNextId}" data-dp-next aria-label="Next month">Next month ›</button></div></div>
      <label>Travellers <select data-gen-id="${spec.paxId}"><option>1 adult</option><option>2 adults</option><option>3 adults</option></select></label>
      <button data-gen-id="${spec.searchId}" data-goto="results">Search flights</button></div>
      <script type="application/json" id="airports">${JSON.stringify(spec.airports.map(([c, code]) => `${c} (${code})`))}</script></section>
    <section data-view="results" hidden><h1>Flights</h1><label><input type="checkbox" data-gen-id="${spec.nonstopId}" data-filter-stops> Non-stop only</label>
      <label>Sort <select data-gen-id="${spec.sortId}" data-sort><option>Recommended</option><option>Cheapest first</option><option>Earliest departure</option></select></label>
      <div data-lazy>${spec.flights.map(flight).join('')}</div><p data-lazy-more>Loading more flights…</p></section>
    <section data-view="gate-payment" hidden><h1>Passenger details and payment</h1><label>Card number <input autocomplete="cc-number"></label></section>`
  }
}

function renderMail(spec) {
  const row = (m) => `<div class="row" data-gen-id="${m.id}" data-item data-from="${esc(m.from)}"><input type="checkbox" data-gen-id="${m.boxId}" aria-label="Select mail from ${esc(m.from)}: ${esc(m.subject)}"><a href="#" data-gen-id="${m.openId}" data-goto="m-${m.id}">${m.unread ? '<b>' : ''}${esc(m.from)} — ${esc(m.subject)}${m.unread ? '</b>' : ''}</a><span style="color:#666">${esc(m.body.slice(0, 40))}…</span></div>`
  const thread = (m) => `<section data-view="m-${m.id}" hidden><h1>${esc(m.subject)}</h1><p>From: ${esc(m.from)}</p><p>${esc(m.body)}</p>${m.newsletter ? `<p><a href="#" data-gen-id="${m.unsubId}" data-goto="unsub" data-unsub="${esc(m.from)}">Unsubscribe</a></p>` : ''}
    <button class="ghost" data-gen-id="${m.replyId}" data-reply>Reply</button><div data-reply-box hidden><textarea aria-label="Reply" data-gen-id="${m.bodyId}"></textarea><br><button class="ghost" data-gen-id="${m.draftId}" data-draft>Save draft</button> <button data-gen-id="${m.sendId}" data-gate="send">Send</button></div></section>`
  return {
    header: `<input type="search" aria-label="Search mail" data-gen-id="${spec.searchId}">`,
    views: `<section data-view="inbox"><h1>Inbox</h1><button class="ghost" data-gen-id="${spec.archiveId}" data-archive>Archive</button><div data-lazy>${spec.mails.map(row).join('')}</div><p data-lazy-more>Loading older mail…</p></section>
    ${spec.mails.map(thread).join('')}
    <section data-view="unsub" hidden><h1>Unsubscribe</h1><p>Stop receiving these emails?</p><button data-gen-id="${spec.unsubConfirmId}" data-unsub-confirm>Unsubscribe</button></section>`
  }
}

function renderFeed(spec) {
  const post = (p) => `<article class="card" data-gen-id="${p.id}" data-item data-topic="${esc(p.topic)}"><strong>${esc(p.author)}</strong> <button class="ghost" data-gen-id="${p.followId}" data-toggle="follow:${p.followId}" aria-pressed="false" aria-label="Follow ${esc(p.author)}">Follow</button><p>${esc(p.text)}</p><button class="ghost" data-gen-id="${p.likeId}" data-toggle="like:${p.id}" aria-pressed="false" aria-label="Like ${esc(p.author)}'s post">Like</button> <button class="ghost" data-gate="send" aria-label="Reply to ${esc(p.author)}">Reply</button></article>`
  return {
    header: `<input type="search" aria-label="Search" data-gen-id="${spec.searchId}" placeholder="Search">`,
    views: `<section data-view="feed"><h1>Home</h1><div data-lazy>${spec.posts.map(post).join('')}</div><p data-lazy-more>Loading more posts…</p></section>`
  }
}


function renderAdmin(spec) {
  const navLinks = spec.nav.map((n) => `<a href="#" data-gen-id="${n.id}" data-goto="${n.view}">${esc(n.label)}</a>`).join('<br>')
  const rows = spec.products.map((p) => `<tr data-gen-id="${p.id}"><td>${esc(p.name)}</td><td>${p.currency} ${p.price}</td><td>${p.interval}</td><td><button class="ghost" data-gen-id="${p.editId}" data-goto="edit-${p.id}" aria-label="Edit ${esc(p.name)}">Edit</button> <button class="ghost" data-gen-id="${p.delId}" data-gate="delete" aria-label="Delete ${esc(p.name)}">Delete</button></td></tr>`).join('')
  const edits = spec.products.map((p) => `<section data-view="edit-${p.id}" hidden><h1>Edit ${esc(p.name)}</h1><label>Price <input data-gen-id="${spec.edit.priceId}-${p.id}" value="${p.price}" inputmode="decimal"></label> <button data-gen-id="${spec.edit.saveId}-${p.id}" data-save-edit="${p.id}">Save changes</button></section>`).join('')
  const f = spec.form, c = spec.coupon
  return {
    views: `<div style="display:flex;gap:24px"><nav aria-label="Dashboard">${navLinks}</nav><div style="flex:1">
    <section data-view="overview"><h1>${esc(spec.app)} overview</h1><p>MRR ₹4.2L · Active subscribers 1,284</p></section>
    <section data-view="products" hidden><h1>Products</h1><button data-gen-id="${spec.createId}" data-goto="new-product">Create product</button><table><thead><tr><th>Name</th><th>Price</th><th>Billing</th><th></th></tr></thead><tbody id="product-rows">${rows}</tbody></table></section>
    <section data-view="new-product" hidden><h1>New product</h1><label>Product name <input data-gen-id="${f.nameId}" required></label><br><label>Price <input data-gen-id="${f.priceId}" inputmode="decimal" required></label><br><label>Currency <select data-gen-id="${f.currencyId}"><option>Select</option><option>INR</option><option>USD</option></select></label>
      <fieldset><legend>Billing</legend>${Object.entries(f.intervalIds).map(([k, gid]) => `<label><input type="radio" name="interval" value="${k}" data-gen-id="${gid}"> ${k}</label>`).join(' ')}</fieldset><button data-gen-id="${f.saveId}" data-save-product>Save product</button></section>
    ${edits}
    <section data-view="coupons" hidden><h1>Coupons</h1><button data-gen-id="${spec.couponCreateId}" data-goto="new-coupon">Create coupon</button><ul id="coupon-rows"></ul></section>
    <section data-view="new-coupon" hidden><h1>New coupon</h1><label>Code <input data-gen-id="${c.codeId}"></label><br><label>Percent off <input data-gen-id="${c.pctId}" inputmode="numeric"></label><br><label>Duration <select data-gen-id="${c.durationId}"><option>Select</option><option>Once</option><option>Repeating</option><option>Forever</option></select></label><br><button data-gen-id="${c.saveId}" data-save-coupon>Save coupon</button></section>
    <section data-view="customers" hidden><h1>Customers</h1><p>1,284 active</p></section><section data-view="settings" hidden><h1>Settings</h1></section>
    <section data-view="gate-delete" hidden><h1>Delete product?</h1><p>This cannot be undone.</p></section>
    </div></div>
    <div class="banner" role="dialog" aria-label="Confirm price change" data-confirm-dialog hidden><span>Existing subscribers keep their price until renewal. Continue?</span><button class="ghost" data-gen-id="${spec.dialog.cancelId}" data-dialog-cancel>Cancel</button><button data-gen-id="${spec.dialog.confirmId}" data-dialog-confirm>Update price</button></div>`
  }
}

function renderResearch(spec) {
  const post = (p) => `<article class="card" data-gen-id="${p.id}" data-item data-name="${esc(p.subject.toLowerCase())}" data-age="${p.ageHours}" data-likes="${p.likes}"><strong>${esc(p.author)}</strong> · ${p.ageHours < 24 ? p.ageHours + 'h' : Math.round(p.ageHours / 24) + 'd'}<p>${esc(p.text)}</p><span>♥ ${p.likes.toLocaleString('en-IN')}</span></article>`
  return {
    header: `<input type="search" aria-label="Search" placeholder="Search" data-gen-id="${spec.searchId}" data-search> <button data-gen-id="${spec.searchGoId}" data-search-go aria-label="Search">Search</button>`,
    views: `<section data-view="home"><h1>Explore</h1><p>Trending: ${spec.posts.slice(0, 4).map((p) => esc(p.subject)).join(' · ')}</p></section>
    <section data-view="results" hidden><h1 id="results-title">Results</h1><div role="tablist"><button role="tab" class="ghost" data-gen-id="${spec.topId}" data-tab-sort="top" aria-selected="false">Top</button><button role="tab" class="ghost" data-gen-id="${spec.latestId}" data-tab-sort="latest" aria-selected="true">Latest</button></div>
    <label>Date <select data-gen-id="${spec.dateId}" data-date-filter><option>Any time</option><option>Past 24 hours</option><option>Past week</option><option>Past month</option></select></label>
    <div data-lazy>${spec.posts.map(post).join('')}</div><p data-lazy-more>Loading more…</p></section>`
  }
}

const RUNTIME = String.raw`
(() => {
  const spec = window.__SPEC
  const $ = (s, r = document) => r.querySelector(s)
  const $$ = (s, r = document) => [...r.querySelectorAll(s)]
  const startView = { shop: 'home', flight: 'home', mail: 'inbox', feed: 'feed', admin: 'overview', research: 'home' }[spec.family] ?? spec.start
  const st = { family: spec.family, view: startView, history: [startView], values: {}, picked: {}, effects: {}, effectTargets: {}, gate: spec.loginWall ? 'login' : null, gatesPassed: [], cookieOpen: !!spec.cookie, query: '', loaded: spec.pageStep, acOpen: null, acOptions: {}, dpOpen: false, dpMonth: 9 }
  const status = (t) => { $('#status').textContent = t }
  function show(view, push = true) {
    for (const s of $$('[data-view]')) s.hidden = s.dataset.view !== view
    st.view = view
    if (push) { st.history.push(view); history.pushState({ view }, '', '#' + view) }
    window.scrollTo(0, 0)
    applyList()
  }
  window.addEventListener('popstate', (e) => { const v = (e.state && e.state.view) || startView; st.history.push(v); show(v, false) })
  function applyList() {
    const lists = $$('[data-view]:not([hidden]) [data-lazy]')
    for (const list of lists) {
      let items = $$('[data-item]', list)
      const q = st.query
      const brands = $$('[data-filter-brand]').filter((b) => b.checked).map((b) => b.dataset.filterBrand)
      const nonstop = $('[data-filter-stops]') && $('[data-filter-stops]').checked
      const sort = $('[data-view]:not([hidden]) [data-sort]')
      const dateSel = $('[data-date-filter]'); const maxAge = dateSel ? ({ 'Past 24 hours': 24, 'Past week': 168, 'Past month': 720 })[dateSel.value] : null
      let shown = items.filter((el) => (!q || !el.dataset.name || el.dataset.name.includes(q)) && (!brands.length || brands.includes(el.dataset.brand)) && (!nonstop || el.dataset.stops === '0') && !el.dataset.archived && (!maxAge || Number(el.dataset.age) <= maxAge))
      const mode = sort ? sort.value : ''
      if (/low to high|Cheapest/.test(mode)) shown.sort((a, b) => a.dataset.price - b.dataset.price)
      if (/high to low/.test(mode)) shown.sort((a, b) => b.dataset.price - a.dataset.price)
      if (st.picked.tab === 'top') shown.sort((a, b) => b.dataset.likes - a.dataset.likes)
      if (st.picked.tab === 'latest' && spec.family === 'research') shown.sort((a, b) => a.dataset.age - b.dataset.age)
      for (const el of items) el.hidden = true
      shown.forEach((el, i) => { list.appendChild(el); el.hidden = i >= st.loaded })
      const more = list.parentElement.querySelector('[data-lazy-more]')
      if (more) more.hidden = shown.length <= st.loaded
      if (shown.length > st.loaded && document.body.scrollHeight <= window.innerHeight + 300) { st.loaded += spec.pageStep; return applyList() }
      st.firstResult = shown[0] ? shown[0].dataset.genId : null
      if (spec.family === 'shop' || spec.family === 'flight' || spec.family === 'research') { const t = $('#results-title'); if (t && q) t.textContent = 'Results for "' + q + '"' }
    }
  }
  window.addEventListener('scroll', () => {
    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 300) { st.loaded += spec.pageStep; applyList() }
  })
  document.addEventListener('click', (e) => {
    const el = e.target.closest('button,a,input[type=checkbox]'); if (!el) return
    if (el.dataset.tabSort) { st.picked.tab = el.dataset.tabSort; $$('[data-tab-sort]').forEach((b) => b.setAttribute('aria-selected', String(b === el))); st.loaded = spec.pageStep; applyList(); return }
    if (el.dataset.saveProduct !== undefined) { const f = spec.form; const name = $('[data-gen-id="' + f.nameId + '"]').value.trim(); const price = $('[data-gen-id="' + f.priceId + '"]').value.trim(); const cur = $('[data-gen-id="' + f.currencyId + '"]').value; const iv = $$('input[name=interval]').find((r) => r.checked); if (!name || !price || cur === 'Select' || !iv) { status('Fill in every field.'); return } st.effects['created:' + name] = true; const tr = document.createElement('tr'); tr.innerHTML = '<td>' + name + '</td><td>' + cur + ' ' + price + '</td><td>' + iv.value + '</td><td></td>'; $('#product-rows').appendChild(tr); status('Product created.'); show('products'); return }
    if (el.dataset.saveEdit) { st.pendingEdit = el.dataset.saveEdit; st.dialogOpen = true; $('[data-confirm-dialog]').hidden = false; return }
    if (el.dataset.dialogConfirm !== undefined) { st.effects['updated:' + st.pendingEdit] = true; st.dialogOpen = false; $('[data-confirm-dialog]').hidden = true; status('Price updated.'); return }
    if (el.dataset.dialogCancel !== undefined) { st.dialogOpen = false; $('[data-confirm-dialog]').hidden = true; return }
    if (el.dataset.saveCoupon !== undefined) { const c = spec.coupon; const code = $('[data-gen-id="' + c.codeId + '"]').value.trim(); const pct = $('[data-gen-id="' + c.pctId + '"]').value.trim(); const d = $('[data-gen-id="' + c.durationId + '"]').value; if (!code || !pct || d === 'Select') { status('Fill in every field.'); return } st.effects['coupon:' + code] = true; const li = document.createElement('li'); li.textContent = code + ' · ' + pct + '% · ' + d; $('#coupon-rows').appendChild(li); status('Coupon created.'); show('coupons'); return }
    if (el.dataset.cookieBtn) { st.cookieOpen = false; st.cookie = el.dataset.cookieBtn; $('[data-cookie]').hidden = true; return }
    if (el.dataset.back !== undefined) { history.back(); return }
    if (el.dataset.gate) { e.preventDefault(); st.gate = el.dataset.gate; if ($('[data-view="gate-' + el.dataset.gate + '"]')) show('gate-' + el.dataset.gate); return }
    if (el.dataset.goto) { e.preventDefault(); if (el.dataset.unsub) st.unsubFrom = el.dataset.unsub; show(el.dataset.goto); return }
    if (el.dataset.searchGo !== undefined) { search(); return }
    if (el.dataset.pickKey) { st.picked[el.dataset.pickKey] = el.dataset.pickValue; $$('[data-pick-key="' + el.dataset.pickKey + '"]').forEach((b) => b.setAttribute('aria-pressed', String(b === el))); return }
    if (el.dataset.add) { const need = (spec.sizeButtons || {})[el.dataset.add]; if (need && need.length && !st.picked[el.dataset.add]) { status('Please choose a size.'); return } st.effects['cart:' + el.dataset.add] = true; status('Added to cart.'); $('#cart-lines') && ($('#cart-lines').textContent = 'Items: ' + Object.keys(st.effects).filter((k) => k.startsWith('cart:')).length); return }
    if (el.dataset.toggle) { const k = el.dataset.toggle; st.effects[k] = !st.effects[k]; st.effectTargets[k] = el.dataset.genId; el.setAttribute('aria-pressed', String(st.effects[k])); if (k.startsWith('follow:')) el.textContent = st.effects[k] ? 'Following' : 'Follow'; return }
    if (el.dataset.archive !== undefined) { const picked = $$('[data-view="inbox"] [data-item]').filter((r) => r.querySelector('input[type=checkbox]').checked); const froms = new Set(picked.map((r) => r.dataset.from)); for (const r of picked) r.dataset.archived = '1'; for (const f of froms) { const left = spec.mails.filter((m) => m.from === f && !document.querySelector('[data-gen-id="' + m.id + '"]').dataset.archived); if (!left.length) st.effects['archived:' + f] = true } status('Archived ' + picked.length + ' conversations.'); applyList(); return }
    if (el.dataset.unsubConfirm !== undefined) { st.effects['unsub:' + st.unsubFrom] = true; status('You are unsubscribed.'); return }
    if (el.dataset.reply !== undefined) { $('[data-view]:not([hidden]) [data-reply-box]').hidden = false; return }
    if (el.dataset.draft !== undefined) { st.effects.draft = true; status('Draft saved.'); return }
    if (el.dataset.dp !== undefined) { st.dpOpen = !st.dpOpen; $('[data-dp-panel]').hidden = !st.dpOpen; return }
    if (el.dataset.dpNext !== undefined) { st.dpMonth = Math.min(10, st.dpMonth + 1); $$('[data-month]').forEach((c) => (c.hidden = Number(c.dataset.month) !== st.dpMonth)); return }
    if (el.dataset.day) { const b = $('[data-dp]'); st.picked[b.dataset.genId] = el.dataset.day; b.textContent = el.dataset.day; st.dpOpen = false; $('[data-dp-panel]').hidden = true; return }
    if (el.dataset.acPick) { const input = $('[data-gen-id="' + el.dataset.acPick + '"]'); input.value = el.dataset.value; st.picked[el.dataset.acPick] = el.dataset.value; closeAc(); return }
  })
  function search() { const box = $('[data-search]'); if (!box) return; st.query = box.value.trim().toLowerCase(); st.loaded = spec.pageStep; show('results') }
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.dataset && e.target.dataset.search !== undefined) search() })
  document.addEventListener('change', (e) => { if (e.target.matches('[data-sort],[data-filter-brand],[data-filter-stops],[data-date-filter]')) { st.loaded = spec.pageStep; applyList() } })
  function closeAc() { st.acOpen = null; st.acOptions = {}; $$('[data-ac-list]').forEach((l) => (l.hidden = true)) }
  let acCount = 0
  document.addEventListener('input', (e) => {
    const el = e.target
    if (el.dataset && el.dataset.ac !== undefined) {
      const list = $('[data-ac-list="' + el.dataset.genId + '"]'); const term = el.value.trim().toLowerCase()
      const names = JSON.parse($('#airports').textContent).filter((n) => term && n.toLowerCase().startsWith(term))
      st.acOptions = {}
      list.innerHTML = ''
      for (const n of names) { const b = document.createElement('button'); b.className = 'ghost'; b.setAttribute('role', 'option'); b.dataset.acPick = el.dataset.genId; b.dataset.value = n; b.dataset.genId = 'ac' + (++acCount); b.textContent = n; list.appendChild(b); st.acOptions[n] = b.dataset.genId }
      list.hidden = !names.length; st.acOpen = names.length ? el.dataset.genId : null
      delete st.picked[el.dataset.genId]
    }
  })
  show(startView, false)
  if (spec.loginWall) st.gate = 'login'
  const visible = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[hidden]')
  window.__og = {
    state() {
      const values = {}
      for (const el of $$('[data-gen-id]')) { if (el.type === 'checkbox' || el.type === 'radio') values[el.dataset.genId] = el.checked; else if ('value' in el && /INPUT|SELECT|TEXTAREA/.test(el.tagName)) values[el.dataset.genId] = el.value }
      const all = $$('[data-gen-id]')
      const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.genId || null : null
      return { ...st, history: [...st.history], effects: { ...st.effects }, picked: { ...st.picked }, values, focused, gatesPassed: [...st.gatesPassed],
        visible: all.filter(visible).map((el) => el.dataset.genId), present: all.filter((el) => !el.closest('[hidden]')).map((el) => el.dataset.genId),
        scrollY: window.scrollY, saving: false }
    },
    userResolve() {
      if (!st.gate) return 'nothing'
      const g = st.gate; st.gatesPassed.push(g); st.gate = null
      if (g === 'login') { const w = $('[data-wall]'); if (w) w.hidden = true; return 'signed in' }
      if (g === 'payment') { status('Order placed.'); return 'entered payment details and paid' }
      if (g === 'send') { status('Sent.'); return 'sent it' }
      if (window.__ogxResolve) return window.__ogxResolve(g)
      return 'done'
    }
  }
  // Families in flows-<name>.mjs add their own listeners after this runtime, on the same state.
  window.__ogx = { st, show, status, $, $$ }
})()`

export { MONTHS, cookieSteps }
