// Builds one random web app page from a seed. Returns its spec (what the label script reads) and
// its HTML. Every element the label script can target carries data-gen-id; the page reports its
// own state through window.__og.state(). window.__og.userResolve() plays the user during a take over.
//
// Families: form, wizard (several form pages), list (find / act / read / open one item),
// bulk (act on many items, the long tasks). Forms and wizards can have a gate (login, payment,
// CAPTCHA) that the user must pass, or a lock that makes the task fail.

import { createRng } from './rng.mjs'
import {
  DOMAINS, SITE_NAMES, NAV_LINKS, FIELD_TEMPLATES, SECTION_TITLES, SINGLE_SECTION_TITLES,
  SUBMIT_LABELS, TOGGLE_LABELS, PRODUCTS, STATUSES, ROW_ACTIONS
} from './vocab-pools.mjs'

const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

export function generatePage(seed, family) {
  const rng = createRng(seed)
  const site = rng.int(0, DOMAINS.length - 1)
  let counter = 0
  const id = (prefix) => `${prefix}${++counter}`
  const base = { seed, domain: DOMAINS[site], siteName: SITE_NAMES[site], theme: theme(rng), nav: navSpec(rng, id) }
  const chosen = family ?? rng.pick(['form', 'form', 'wizard', 'list', 'list', 'bulk'])
  const spec = chosen === 'form' ? formSpec(rng, base, id)
    : chosen === 'wizard' ? wizardSpec(rng, base, id)
      : listSpec(rng, base, id, chosen === 'bulk')
  return { spec, html: render(spec) }
}

// ---------- specs ----------

function sectionsSpec(rng, id, maxExtra = 4) {
  const twin = rng.chance(0.45)
  const titles = twin ? rng.pick(SECTION_TITLES) : [rng.pick(SINGLE_SECTION_TITLES)]
  const sharedKeys = rng.sample(['name', 'email', 'phone', 'city', 'zip', 'first', 'last'], rng.int(2, 4))
  const sections = titles.map((title, index) => {
    const extra = index === 0 ? rng.sample(FIELD_TEMPLATES.filter((f) => !sharedKeys.includes(f.key)), rng.int(1, maxExtra)) : []
    const templates = [...FIELD_TEMPLATES.filter((f) => sharedKeys.includes(f.key)), ...extra]
    const labelPick = rng.next()
    const fields = rng.shuffle(templates).map((template) => {
      const options = template.options ? template.options(rng) : null
      return {
        id: id('f'),
        key: template.key,
        label: template.labels[Math.floor(labelPick * template.labels.length)],
        kind: template.kind,
        options,
        labelMode: template.kind === 'radio' || template.kind === 'checkbox'
          ? 'wrap'
          : rng.pick(['wrap', 'wrap', 'for', 'for', 'aria', 'placeholder', 'none']),
        initial: template.kind === 'checkbox' ? rng.chance(0.3) : template.kind === 'select' ? options[0] : ''
      }
    })
    return { id: id('s'), title, fields, collapsed: false, toggleId: null, toggleLabel: null }
  })
  // Hide part of one section behind a toggle, so some tasks need a click to reveal fields.
  if (rng.chance(0.35)) {
    const section = rng.pick(sections)
    if (section.fields.length > 1) {
      section.collapsed = true
      section.toggleId = id('t')
      section.toggleLabel = rng.pick(TOGGLE_LABELS)
    }
  }
  return sections
}

function gateSpec(rng, id) {
  const roll = rng.next()
  if (roll < 0.15) return { kind: 'login', emailId: id('g'), passwordId: id('g'), buttonId: id('g') }
  if (roll < 0.28) return { kind: 'payment', cardId: id('g'), buttonId: id('g') }
  if (roll < 0.38) return { kind: 'captcha', boxId: id('g'), buttonId: id('g') }
  return null
}

function formSpec(rng, base, id) {
  return {
    ...base,
    family: 'form',
    path: rng.pick(['/profile', '/checkout', '/booking/new', '/account/edit', '/tickets/new', '/apply']),
    heading: rng.pick(['Edit profile', 'Checkout', 'New booking', 'Account settings', 'New request', 'Application form']),
    pages: [{ id: id('p'), title: null, sections: sectionsSpec(rng, id), nextId: null }],
    submit: { id: id('b'), label: rng.pick(SUBMIT_LABELS) },
    saveDelayMs: rng.chance(0.5) ? rng.int(700, 2500) : 0,
    reference: `${rng.pick(['REF', 'ORD', 'TKT', 'BK'])}-${rng.int(10000, 99999)}`,
    newsletter: rng.chance(0.4) ? { id: id('f'), label: 'Email', button: { id: id('b'), label: 'Subscribe' } } : null,
    gate: gateSpec(rng, id),
    locked: rng.chance(0.12)
  }
}

function wizardSpec(rng, base, id) {
  const titles = rng.sample(['Contact', 'Address', 'Travel', 'Preferences', 'Payment details', 'Work history', 'Documents', 'Extras'], rng.int(2, 6))
  return {
    ...base,
    family: 'wizard',
    path: rng.pick(['/apply', '/signup', '/onboarding', '/booking/new']),
    heading: rng.pick(['Application', 'Sign up', 'Onboarding', 'New booking']),
    pages: titles.map((title) => ({ id: id('p'), title, sections: sectionsSpec(rng, id, 3), nextId: id('b') })),
    submit: { id: id('b'), label: rng.pick(['Submit application', 'Finish', 'Confirm booking', 'Complete sign up']) },
    saveDelayMs: rng.chance(0.5) ? rng.int(700, 2500) : 0,
    reference: `${rng.pick(['APP', 'BK', 'REG'])}-${rng.int(10000, 99999)}`,
    newsletter: null,
    gate: gateSpec(rng, id),
    locked: rng.chance(0.1)
  }
}

function listSpec(rng, base, id, bulk) {
  const count = bulk ? rng.int(30, 200) : rng.int(6, 18)
  const names = bulk
    ? Array.from({ length: count }, (_, i) => `${rng.pick(PRODUCTS)} ${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26) + 1}`)
    : rng.sample(PRODUCTS, count)
  const rowAction = rng.pick(ROW_ACTIONS)
  const statuses = bulk ? rng.sample(STATUSES, 3) : STATUSES
  const rows = names.map((name) => ({
    id: id('r'),
    name,
    sku: `${name.slice(0, 2).toUpperCase()}-${rng.int(100, 999)}`,
    price: `₹${rng.int(2, 250) * 10}`,
    stock: rng.int(0, 120),
    status: rng.pick(statuses),
    actionId: id('a'),
    openId: id('o'),
    stockId: id('k'),
    saveId: id('v')
  }))
  const pageSize = bulk ? rng.pick([8, 10, 12, 20]) : rng.pick([5, 6, 8, 10, 100])
  return {
    ...base,
    family: bulk ? 'bulk' : 'list',
    path: rng.pick(['/inventory', '/products', '/orders', '/catalog', '/items']),
    heading: rng.pick(['Inventory', 'Products', 'Orders', 'Catalog', 'Items']),
    rows,
    rowAction,
    editable: bulk && rng.chance(0.5),
    pageSize,
    paging: rows.length > pageSize ? { nextId: id('b'), prevId: id('b') } : null,
    searchBox: rng.chance(bulk ? 0.3 : 0.6) ? { id: id('q'), label: rng.pick(['Search', 'Filter items', 'Find a product']), buttonId: id('b') } : null,
    dialog: { confirmId: id('b'), cancelId: id('b') }
  }
}

function navSpec(rng, id) {
  return rng.sample(NAV_LINKS, rng.int(2, 5)).map((label) => ({ id: id('n'), label }))
}

function theme(rng) {
  return {
    font: rng.pick(['system-ui', 'Georgia, serif', '"Helvetica Neue", Arial', 'Verdana, sans-serif', 'monospace']),
    accent: rng.pick(['#2563eb', '#16a34a', '#db2777', '#ea580c', '#7c3aed', '#0f766e', '#334155']),
    bg: rng.pick(['#ffffff', '#f8fafc', '#fdf6ec', '#0f172a', '#f1f5f9']),
    columns: rng.pick([1, 1, 2]),
    gap: rng.int(6, 22),
    radius: rng.int(0, 12),
    width: rng.pick([520, 720, 960, 1200])
  }
}

// ---------- HTML ----------

function render(spec) {
  const t = spec.theme
  const dark = t.bg === '#0f172a'
  const css = `
  body{margin:0;font-family:${t.font};background:${t.bg};color:${dark ? '#e2e8f0' : '#0f172a'}}
  header{display:flex;gap:16px;align-items:center;padding:12px 20px;border-bottom:1px solid #cbd5e1}
  header a{color:${t.accent};text-decoration:none}
  main{max-width:${t.width}px;margin:20px auto;padding:0 16px}
  .grid{display:grid;grid-template-columns:repeat(${t.columns},1fr);gap:${t.gap}px}
  .field{display:flex;flex-direction:column;gap:4px}
  input,select,textarea{padding:8px;border:1px solid #94a3b8;border-radius:${t.radius}px;font:inherit}
  button{padding:8px 14px;border:0;border-radius:${t.radius}px;background:${t.accent};color:#fff;font:inherit;cursor:pointer}
  button.ghost{background:transparent;color:${t.accent};border:1px solid ${t.accent}}
  section{margin:${t.gap}px 0;padding:${t.gap}px;border:1px solid #cbd5e1;border-radius:${t.radius}px}
  table{width:100%;border-collapse:collapse} td,th{padding:6px;border-bottom:1px solid #cbd5e1;text-align:left}
  td input{width:70px}
  .dialog{position:fixed;inset:0;background:#0006;display:flex;align-items:center;justify-content:center}
  .dialog>div{background:${dark ? '#1e293b' : '#fff'};padding:24px;border-radius:${t.radius}px}
  [hidden]{display:none!important}`
  const nav = spec.nav.map((n) => `<a href="#" data-gen-id="${n.id}" data-nav="${esc(n.label)}">${esc(n.label)}</a>`).join('')
  const isForm = spec.family === 'form' || spec.family === 'wizard'
  const body = isForm ? renderForm(spec) : renderList(spec)
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(spec.heading)} – ${esc(spec.siteName)}</title><style>${css}</style></head>
<body><header><strong>${esc(spec.siteName)}</strong><nav style="display:flex;gap:12px">${nav}</nav></header>
<main id="view-main"><h1>${esc(spec.heading)}</h1>${body}</main>
${spec.gate ? renderGate(spec.gate) : ''}
<main id="view-other" hidden><h1 id="other-title"></h1><p>This page is not part of your task.</p><a href="#" data-gen-id="back" id="back-link">Back</a></main>
<script>window.__SPEC=${JSON.stringify(spec).replace(/</g, '\\u003c')};${RUNTIME}</script></body></html>`
}

function renderGate(gate) {
  if (gate.kind === 'login') {
    return `<main id="view-gate" hidden><h1>Sign in to continue</h1>
    <label class="field">Email <input type="email" data-gen-id="${gate.emailId}"></label>
    <label class="field">Password <input type="password" data-gen-id="${gate.passwordId}"></label>
    <button type="button" data-gen-id="${gate.buttonId}" data-gate-submit>Sign in</button></main>`
  }
  if (gate.kind === 'payment') {
    return `<main id="view-gate" hidden><h1>Payment</h1><p>Enter your card to finish.</p>
    <label class="field">Card number <input inputmode="numeric" autocomplete="cc-number" data-gen-id="${gate.cardId}"></label>
    <button type="button" data-gen-id="${gate.buttonId}" data-gate-submit>Pay now</button></main>`
  }
  return `<main id="view-gate" hidden><h1>Security check</h1>
    <label><input type="checkbox" data-gen-id="${gate.boxId}"> I am not a robot</label>
    <button type="button" data-gen-id="${gate.buttonId}" data-gate-submit>Verify</button></main>`
}

function renderSections(sections, multi) {
  return sections.map((section) => {
    const head = multi || section.collapsed ? `<h2>${esc(section.title)}</h2>` : ''
    if (!section.collapsed) return `<section aria-label="${esc(section.title)}">${head}<div class="grid">${section.fields.map(renderField).join('')}</div></section>`
    const half = Math.ceil(section.fields.length / 2)
    return `<section aria-label="${esc(section.title)}">${head}<div class="grid">${section.fields.slice(0, half).map(renderField).join('')}</div>
      <button type="button" class="ghost" data-gen-id="${section.toggleId}" data-toggle="${section.id}" aria-expanded="false">${esc(section.toggleLabel)}</button>
      <div class="grid" id="more-${section.id}" hidden>${section.fields.slice(half).map(renderField).join('')}</div></section>`
  }).join('')
}

function renderForm(spec) {
  const wizard = spec.family === 'wizard'
  const pages = spec.pages.map((page, index) => {
    const last = index === spec.pages.length - 1
    const steps = wizard ? `<p>Step ${index + 1} of ${spec.pages.length}: ${esc(page.title)}</p>` : ''
    const button = wizard && !last
      ? `<button type="button" data-gen-id="${page.nextId}" data-next-page>Continue</button>`
      : `<button type="submit" data-gen-id="${spec.submit.id}" data-submit>${esc(spec.submit.label)}</button>`
    return `<div class="wizard-page" data-page="${index}"${index > 0 ? ' hidden' : ''}>${steps}${renderSections(page.sections, page.sections.length > 1)}${button}</div>`
  }).join('')
  const newsletter = spec.newsletter
    ? `<aside><h3>Newsletter</h3><label>${esc(spec.newsletter.label)} <input type="email" data-gen-id="${spec.newsletter.id}"></label> <button type="button" data-gen-id="${spec.newsletter.button.id}" data-newsletter>Subscribe</button></aside>`
    : ''
  return `<form onsubmit="return false">${pages}<p role="status" id="status"></p></form>${newsletter}`
}

function renderField(field) {
  const gid = `data-gen-id="${field.id}"`
  if (field.kind === 'checkbox') {
    return `<label class="field" style="flex-direction:row"><input type="checkbox" ${gid}${field.initial ? ' checked' : ''}> ${esc(field.label)}</label>`
  }
  if (field.kind === 'radio') {
    const options = field.options.map((option, index) =>
      `<label><input type="radio" name="${field.id}" value="${esc(option)}" data-gen-id="${field.id}-${index}"> ${esc(option)}</label>`).join(' ')
    return `<fieldset class="field" ${gid}><legend>${esc(field.label)}</legend>${options}</fieldset>`
  }
  const control = (attrs) => {
    if (field.kind === 'select') return `<select ${gid} ${attrs}>${field.options.map((o) => `<option>${esc(o)}</option>`).join('')}</select>`
    if (field.kind === 'textarea') return `<textarea ${gid} ${attrs}></textarea>`
    return `<input type="${field.kind}" ${gid} ${attrs}>`
  }
  switch (field.labelMode) {
    case 'for': return `<div class="field"><label for="in-${field.id}">${esc(field.label)}</label>${control(`id="in-${field.id}"`)}</div>`
    case 'aria': return `<div class="field">${control(`aria-label="${esc(field.label)}"`)}</div>`
    case 'placeholder':
      return field.kind === 'select'
        ? `<div class="field">${control(`aria-label="${esc(field.label)}"`)}</div>`
        : `<div class="field">${control(`placeholder="${esc(field.label)}"`)}</div>`
    case 'none': return `<div class="field"><div>${esc(field.label)}</div>${control('')}</div>`
    default: return `<label class="field">${esc(field.label)}${control('')}</label>`
  }
}

function renderList(spec) {
  const search = spec.searchBox
    ? `<div role="search"><input type="search" aria-label="${esc(spec.searchBox.label)}" data-gen-id="${spec.searchBox.id}"> <button type="button" data-gen-id="${spec.searchBox.buttonId}" data-search>Search</button></div>`
    : ''
  const paging = spec.paging
    ? `<div><button type="button" class="ghost" data-gen-id="${spec.paging.prevId}" data-prev>Previous</button> <span id="page-label"></span> <button type="button" class="ghost" data-gen-id="${spec.paging.nextId}" data-next>Next</button></div>`
    : ''
  return `${search}<table><thead><tr><th>Name</th><th>SKU</th><th>Price</th><th>Stock</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table>
  <p id="empty" hidden>No items match.</p>${paging}<p role="status" id="status"></p>
  <div class="dialog" id="dialog" hidden><div role="dialog" aria-modal="true" aria-labelledby="dialog-title"><h2 id="dialog-title"></h2>
  <button type="button" class="ghost" data-gen-id="${spec.dialog.cancelId}" data-cancel>Cancel</button> <button type="button" data-gen-id="${spec.dialog.confirmId}" data-confirm>${esc(spec.rowAction)}</button></div></div>`
}

// Page behaviour. Kept as plain browser JS: one copy runs in every generated page.
const RUNTIME = String.raw`
(() => {
  const spec = window.__SPEC
  const $ = (s) => document.querySelector(s)
  const isList = spec.family === 'list' || spec.family === 'bulk'
  const st = { view: 'main', other: null, saving: false, submitted: false, locked: false, page: 0, wizardPage: 0, query: '', deleted: [], pendingRow: null, opened: null, gate: null, gatePassed: false, stock: {}, savedStock: {} }
  for (const r of spec.rows || []) { st.stock[r.id] = String(r.stock); st.savedStock[r.id] = String(r.stock) }
  const views = () => ({ main: $('#view-main'), other: $('#view-other'), gate: $('#view-gate') })
  const show = (view, title) => {
    st.view = view; st.other = view === 'other' ? title : null
    for (const [name, el] of Object.entries(views())) if (el) el.hidden = name !== view
    if (view === 'other') $('#other-title').textContent = title
  }
  let returnView = 'main'
  const openGate = (after) => { st.gate = spec.gate.kind; st.gateAfter = after; show('gate') }
  const passGate = () => {
    st.gate = null; st.gatePassed = true; show('main')
    if (st.gateAfter === 'submit') finishSubmit()
  }
  if (spec.gate && spec.gate.kind === 'login') openGate('start')
  document.addEventListener('click', (e) => {
    const el = e.target.closest('a,button'); if (!el) return
    if (el.dataset.nav) { e.preventDefault(); returnView = st.view; show('other', el.dataset.nav); return }
    if (el.id === 'back-link') { e.preventDefault(); show(returnView === 'other' ? 'main' : returnView); return }
    if (el.dataset.gateSubmit !== undefined) { $('#status') && ($('#status').textContent = ''); return }
    if (el.dataset.toggle) { const more = $('#more-' + el.dataset.toggle); more.hidden = !more.hidden; el.setAttribute('aria-expanded', String(!more.hidden)); return }
    if (el.dataset.newsletter !== undefined) return
    if (el.dataset.nextPage !== undefined) { st.wizardPage = Math.min(st.wizardPage + 1, spec.pages.length - 1); renderWizard(); return }
    if (el.dataset.submit !== undefined) { submit(); return }
    if (el.dataset.next !== undefined) { st.page = Math.min(st.page + 1, pages() - 1); renderRows(); return }
    if (el.dataset.prev !== undefined) { st.page = Math.max(st.page - 1, 0); renderRows(); return }
    if (el.dataset.search !== undefined) { st.query = $('[data-gen-id="' + spec.searchBox.id + '"]').value.trim().toLowerCase(); st.page = 0; renderRows(); return }
    if (el.dataset.row) { st.pendingRow = el.dataset.row; const row = spec.rows.find((r) => r.id === el.dataset.row); $('#dialog-title').textContent = spec.rowAction + ' ' + row.name + '?'; $('#dialog').hidden = false; return }
    if (el.dataset.saveRow) { const r = el.dataset.saveRow; st.savedStock[r] = st.stock[r]; $('#status').textContent = 'Stock saved for ' + spec.rows.find((x) => x.id === r).name + '.'; return }
    if (el.dataset.open) { e.preventDefault(); const row = spec.rows.find((r) => r.id === el.dataset.open); st.opened = row.id; $('#status').textContent = row.name + ': ' + row.stock + ' in stock, status ' + row.status + '.'; return }
    if (el.dataset.cancel !== undefined) { st.pendingRow = null; $('#dialog').hidden = true; return }
    if (el.dataset.confirm !== undefined) { st.deleted.push(st.pendingRow); const row = spec.rows.find((r) => r.id === st.pendingRow); st.pendingRow = null; $('#dialog').hidden = true; $('#status').textContent = row.name + ' ' + (spec.rowAction === 'Delete' ? 'deleted' : spec.rowAction === 'Remove' ? 'removed' : 'archived') + '.'; if (st.page >= pages()) st.page = pages() - 1; renderRows(); return }
  })
  document.addEventListener('input', (e) => { const r = e.target.dataset && e.target.dataset.stockRow; if (r) st.stock[r] = e.target.value })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && spec.searchBox && e.target.dataset && e.target.dataset.genId === spec.searchBox.id) {
      st.query = e.target.value.trim().toLowerCase(); st.page = 0; renderRows()
    }
  })
  function submit() {
    if (st.saving || st.submitted || st.locked) return
    if (spec.locked) { st.locked = true; $('#status').textContent = 'Your account is locked. Contact support to continue.'; return }
    if (spec.gate && spec.gate.kind !== 'login' && !st.gatePassed) { openGate('submit'); return }
    finishSubmit()
  }
  function finishSubmit() {
    const done = () => { st.saving = false; st.submitted = true; $('#status').textContent = 'Saved. Your reference is ' + spec.reference + '.' }
    if (!spec.saveDelayMs) return done()
    st.saving = true; $('#status').textContent = 'Saving…'
    setTimeout(done, spec.saveDelayMs)
  }
  function renderWizard() {
    for (const el of document.querySelectorAll('.wizard-page')) el.hidden = Number(el.dataset.page) !== st.wizardPage
  }
  const visibleRows = () => (spec.rows || []).filter((r) => !st.deleted.includes(r.id) && (!st.query || r.name.toLowerCase().includes(st.query)))
  const pages = () => Math.max(1, Math.ceil(visibleRows().length / spec.pageSize))
  const rowEls = {}
  function renderRows() {
    if (!isList) return
    const rows = visibleRows(); const start = st.page * spec.pageSize
    // Reuse each row's element, so Playwright keeps its refs stable between renders.
    const html = (r) => {
      const stock = spec.editable
        ? '<input type="number" aria-label="Stock for ' + r.name + '" data-gen-id="' + r.stockId + '" data-stock-row="' + r.id + '" value="' + st.stock[r.id] + '"> <button type="button" class="ghost" data-save-row="' + r.id + '" data-gen-id="' + r.saveId + '" aria-label="Save stock for ' + r.name + '">Save</button>'
        : r.stock
      return '<td><a href="#" data-open="' + r.id + '" data-gen-id="' + r.openId + '">' + r.name + '</a></td><td>' + r.sku + '</td><td>' + r.price + '</td><td>' + stock + '</td><td>' + r.status + '</td><td><button type="button" class="ghost" data-row="' + r.id + '" data-gen-id="' + r.actionId + '" aria-label="' + spec.rowAction + ' ' + r.name + '">' + spec.rowAction + '</button></td>'
    }
    const body = $('#rows')
    const wanted = rows.slice(start, start + spec.pageSize).map((r) => {
      if (!rowEls[r.id]) { const tr = document.createElement('tr'); tr.dataset.genId = r.id; tr.innerHTML = html(r); rowEls[r.id] = tr }
      return rowEls[r.id]
    })
    for (const el of [...body.children]) if (!wanted.includes(el)) el.remove()
    wanted.forEach((el, i) => { if (body.children[i] !== el) body.insertBefore(el, body.children[i] || null) })
    $('#empty').hidden = rows.length > 0
    if (spec.paging) $('#page-label').textContent = 'Page ' + (st.page + 1) + ' of ' + pages()
  }
  renderRows()
  const visible = (el) => !!el && el.getClientRects().length > 0 && !el.closest('[hidden]')
  window.__og = {
    state() {
      const values = {}
      for (const el of document.querySelectorAll('[data-gen-id]')) {
        const gid = el.dataset.genId
        if (el.tagName === 'FIELDSET') { const c = el.querySelector('input:checked'); values[gid] = c ? c.value : null }
        else if (el.type === 'checkbox') values[gid] = el.checked
        else if (el.type === 'radio') continue
        else if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') values[gid] = el.value
      }
      const shown = [...document.querySelectorAll('[data-gen-id]')].filter(visible).map((el) => el.dataset.genId)
      const visibleRowIds = [...document.querySelectorAll('#rows tr')].filter(visible).map((el) => el.dataset.genId)
      const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.genId || null : null
      return { ...st, focused, deleted: [...st.deleted], stock: { ...st.stock }, savedStock: { ...st.savedStock }, values, visible: shown, visibleRowIds,
        dialogOpen: !$('#dialog') ? false : !$('#dialog').hidden, status: ($('#status') || {}).textContent || '', pageCount: isList ? pages() : 1,
        matchCount: isList ? visibleRows().length : 0 }
    },
    /** The user passes the gate during a take over. Returns what the user did. */
    userResolve() {
      if (!st.gate) return 'nothing'
      const kind = st.gate; passGate()
      return kind === 'login' ? 'signed in' : kind === 'payment' ? 'paid' : 'passed the security check'
    }
  }
})()`
