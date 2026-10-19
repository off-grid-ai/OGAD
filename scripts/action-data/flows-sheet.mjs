// Spreadsheet flow (Google Sheets style): a grid with A1 refs, a Name box, a formula bar, column
// menus that sort the sheet, and an Add row button. Tasks: edit a cell, add a row, sort by a
// column, read a value.

import { esc, cookieSteps, flowStepDone } from './flows.mjs'
import { FIRST_NAMES, LAST_NAMES, CITIES, PRODUCTS } from './vocab-pools.mjs'

const LETTERS = ['A', 'B', 'C', 'D', 'E']
const DATASETS = {
  sales: { title: 'Q3 sales', headers: ['Name', 'City', 'Region', 'Units', 'Revenue'], row: (rng, key) => [key, rng.pick(CITIES), rng.pick(['North', 'South', 'East', 'West']), String(rng.int(5, 400)), String(rng.int(20, 900) * 100)], key: (rng) => `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}` },
  inventory: { title: 'Stock list', headers: ['Item', 'Category', 'Stock', 'Price', 'Supplier'], row: (rng, key) => [key, rng.pick(['Office', 'Electronics', 'Home', 'Travel']), String(rng.int(0, 250)), String(rng.int(2, 300) * 10), `${rng.pick(LAST_NAMES)} ${rng.pick(['Traders', 'Supplies', 'Imports'])}`], key: (rng) => `${rng.pick(PRODUCTS)} ${rng.pick(['S', 'M', 'L', 'Pro', 'Mini', 'Max'])}` },
  team: { title: 'Team roster', headers: ['Name', 'Team', 'Location', 'Salary', 'Start year'], row: (rng, key) => [key, rng.pick(['Design', 'Sales', 'Platform', 'Support', 'Finance']), rng.pick(CITIES), String(rng.int(40, 400) * 1000), String(rng.int(2012, 2026))], key: (rng) => `${rng.pick(FIRST_NAMES)} ${rng.pick(LAST_NAMES)}` }
}

function sheetSpec(rng, base, id) {
  const kindName = rng.pick(Object.keys(DATASETS))
  const ds = DATASETS[kindName]
  const keys = new Set()
  const n = rng.int(12, 36)
  let guard = 0
  while (keys.size < n && guard++ < 500) keys.add(ds.key(rng))
  const rows = [...keys].map((k) => ds.row(rng, k))
  const spec = {
    ...base, start: 'sheet', path: rng.pick(['/spreadsheets/d/1x/edit', '/sheets/budget', '/s/edit']), heading: ds.title, title: ds.title, headers: ds.headers, rows, letters: LETTERS,
    nameBoxId: id('nb'), fxId: id('fx'), addRowId: id('ar'), colMenuIds: Object.fromEntries(LETTERS.map((l) => [l, id('cm')])), sortAscId: id('sa'), sortDescId: id('sd')
  }
  const steps = [...cookieSteps(spec)]
  const goTo = (ref, also = null) => ({ title: `Go to cell ${ref}`, check: `textbox "Name box" = ${ref}`, test: { type: 'any', of: [{ type: 'picked', key: 'cell', value: ref }, ...(also ? [also] : [])] }, view: 'sheet', action: { kind: 'goto', ref } })
  const setCell = (ref, value) => {
    const key = `cell:${ref}=${value}`
    steps.push(goTo(ref, { type: 'effect', key }))
    steps.push({ title: `Type ${value} in the formula bar`, check: `textbox "Formula bar" = ${value}`, test: { type: 'cellTyped', cell: ref, value, key, fx: spec.fxId }, view: 'sheet', action: { kind: 'fx', value } })
    steps.push({ title: 'Press Enter to save the cell', check: `cell ${ref} = ${value}`, test: { type: 'effect', key }, view: 'sheet', action: { kind: 'commit', value } })
    return key
  }
  const numeric = [2, 3, 4].filter((c) => /^\d+$/.test(rows[0][c]))
  const kind = rng.pick(['edit', 'edit', 'add', 'sort', 'read'])
  if (kind === 'edit') {
    const r = rng.int(0, rows.length - 1); const c = rng.pick([1, 2, 3, 4])
    const ref = `${LETTERS[c]}${r + 2}`
    const value = /^\d+$/.test(rows[r][c]) ? String(Number(rows[r][c]) + rng.int(1, 50) * (Number(rows[r][c]) > 1000 ? 100 : 1)) : rng.pick(c === 1 || c === 2 ? CITIES.concat(['North', 'South', 'Design', 'Sales', 'Office', 'Home']).filter((x) => x !== rows[r][c]) : ['Kapoor Supplies', 'Nair Imports'])
    const key = setCell(ref, value)
    const goal = rng.pick([`In the ${ds.title} sheet, change ${ds.headers[c]} for ${rows[r][0]} to ${value}.`, `Set cell ${ref} to ${value}.`, `Update ${rows[r][0]}'s ${ds.headers[c].toLowerCase()} to ${value} in the sheet.`])
    return { spec, task: { family: 'sheet', goal, steps, answer: `${ref} is now ${value}`, done: { type: 'effect', key } } }
  }
  if (kind === 'add') {
    const key0 = ds.key(rng); if (keys.has(key0)) return sheetSpec(rng, base, id)
    const row = ds.row(rng, key0)
    const cols = [0, ...rng.sample([1, 2, 3, 4], rng.int(1, 2)).sort()]
    const r = rows.length + 2
    steps.push({ title: 'Click Add row', check: `textbox "Name box" = A${r}`, test: { type: 'effect', key: 'rowAdded' }, view: 'sheet', action: { kind: 'click', id: spec.addRowId } })
    const keys2 = cols.map((c) => setCell(`${LETTERS[c]}${r}`, row[c]))
    const goal = `Add a row to the sheet for ${row[0]} with ${cols.slice(1).map((c) => `${ds.headers[c]} ${row[c]}`).join(' and ')}.`
    return { spec, task: { family: 'sheet', goal, steps, answer: `Added ${row[0]} in row ${r}`, done: { type: 'effects', keys: keys2 } } }
  }
  if (kind === 'sort') {
    const c = rng.pick(numeric.length ? [0, ...numeric] : [0])
    const dir = c === 0 ? rng.pick(['asc', 'desc']) : rng.pick(['asc', 'desc', 'desc'])
    const word = dir === 'asc' ? 'A to Z' : 'Z to A'
    const sorted = [...rows].sort((a, b) => cmp(a[c], b[c]) * (dir === 'asc' ? 1 : -1))
    steps.push({ title: `Sort the sheet by column ${LETTERS[c]}, ${word}`, check: `sheet sorted by column ${LETTERS[c]}, ${word}`, test: { type: 'effect', key: `sort:${LETTERS[c]}:${dir}` }, view: 'sheet', action: { kind: 'menu', col: LETTERS[c], item: dir === 'asc' ? spec.sortAscId : spec.sortDescId } })
    const top = rng.chance(0.5) && c !== 0
    const goal = top
      ? `Which ${ds.headers[0].toLowerCase()} has the ${dir === 'asc' ? 'lowest' : 'highest'} ${ds.headers[c].toLowerCase()}? Sort the sheet by ${ds.headers[c]} to find it.`
      : `Sort the sheet by ${ds.headers[c]}, ${c === 0 ? word : dir === 'asc' ? 'smallest first' : 'largest first'}.`
    return { spec, task: { family: 'sheet', goal, steps, answer: top ? `${sorted[0][0]} (${sorted[0][c]})` : `Sorted by ${ds.headers[c]}, ${word}`, done: { type: 'effect', key: `sort:${LETTERS[c]}:${dir}` } } }
  }
  const r = rng.int(0, rows.length - 1); const c = rng.pick([1, 2, 3, 4])
  const ref = `${LETTERS[c]}${r + 2}`
  steps.push(goTo(ref))
  const goal = rng.pick([`What is the ${ds.headers[c]} for ${rows[r][0]} in the ${ds.title} sheet?`, `Read cell ${ref} and tell me its value.`])
  return { spec, task: { family: 'sheet', goal, steps, answer: rows[r][c], done: { type: 'picked', key: 'cell', value: ref } } }
}

const cmp = (a, b) => (/^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b))

function renderSheet(spec) {
  const head = `<tr><th></th>${spec.letters.map((l) => `<th role="columnheader">${l} <button class="ghost cm" data-gen-id="${spec.colMenuIds[l]}" data-col-menu="${l}" aria-label="Column ${l} menu">▾</button></th>`).join('')}</tr>`
  return {
    views: `<section data-view="sheet"><h1>${esc(spec.title)}</h1>
      <div class="bar"><input class="nb" data-gen-id="${spec.nameBoxId}" data-name-box aria-label="Name box" value="A1" autocomplete="off"> <span>fx</span> <input class="fx" data-gen-id="${spec.fxId}" data-fx aria-label="Formula bar" autocomplete="off"> <button class="ghost" data-gen-id="${spec.addRowId}" data-add-row>Add row</button></div>
      <div role="menu" aria-label="Column menu" class="menu" data-sort-menu hidden><button role="menuitem" class="ghost" data-gen-id="${spec.sortAscId}" data-sort-dir="asc">Sort sheet A to Z</button><button role="menuitem" class="ghost" data-gen-id="${spec.sortDescId}" data-sort-dir="desc">Sort sheet Z to A</button></div>
      <table role="grid" class="sheet" aria-label="${esc(spec.title)}"><thead>${head}</thead><tbody data-sheet-body></tbody></table></section>`
  }
}

const css = `
  .bar{display:flex;gap:8px;align-items:center;margin:8px 0} .nb{width:70px} .fx{flex:1}
  table.sheet{border-collapse:collapse;font-size:13px} .sheet td,.sheet th{border:1px solid #ddd;padding:3px 8px;min-width:90px;height:20px}
  .sheet th{background:#f3f3f3} .sheet td[aria-selected=true]{outline:2px solid #1a73e8} .cm{padding:0 4px}
  .menu{position:absolute;background:#fff;border:1px solid #ccc;display:flex;flex-direction:column;z-index:4}`

const runtime = String.raw`
;(() => {
  const { st, status, $, $$ } = window.__ogx
  const spec = window.__SPEC
  const L = spec.letters
  const data = [spec.headers.slice()].concat(spec.rows.map((r) => r.slice()))
  const nameBox = $('[data-name-box]'); const fx = $('[data-fx]')
  const num = (v) => /^\d+$/.test(v)
  function draw() {
    const body = $('[data-sheet-body]'); body.innerHTML = ''
    data.forEach((row, i) => {
      const tr = document.createElement('tr')
      const th = document.createElement('th'); th.setAttribute('role', 'rowheader'); th.textContent = String(i + 1); tr.appendChild(th)
      L.forEach((l, c) => { const td = document.createElement('td'); td.setAttribute('role', 'gridcell'); td.dataset.cell = l + (i + 1); td.textContent = row[c] || ''; if (st.picked.cell === td.dataset.cell) td.setAttribute('aria-selected', 'true'); tr.appendChild(td) })
      body.appendChild(tr)
    })
  }
  function parse(ref) { const m = /^([A-Z])(\d+)$/.exec(ref.trim().toUpperCase()); if (!m) return null; const c = L.indexOf(m[1]); const r = Number(m[2]) - 1; return c < 0 || r < 0 || r >= data.length ? null : { c, r, ref: m[1] + m[2] } }
  function select(ref) { const p = parse(ref); if (!p) { status('Invalid cell reference.'); return } st.picked.cell = p.ref; nameBox.value = p.ref; fx.value = data[p.r][p.c] || ''; draw() }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    if (e.target === nameBox) { e.preventDefault(); select(nameBox.value); return }
    if (e.target === fx) {
      e.preventDefault(); const p = parse(st.picked.cell || ''); if (!p) return
      data[p.r][p.c] = fx.value.trim(); st.effects['cell:' + p.ref + '=' + fx.value.trim()] = true; draw(); return
    }
  })
  document.addEventListener('click', (e) => {
    const td = e.target.closest('td[data-cell]'); if (td) { select(td.dataset.cell); return }
    const el = e.target.closest('button'); if (!el) return
    const menu = $('[data-sort-menu]')
    if (el.dataset.colMenu) { const open = st.menuCol !== el.dataset.colMenu; st.menuCol = open ? el.dataset.colMenu : null; menu.hidden = !open; menu.setAttribute('aria-label', 'Column ' + el.dataset.colMenu + ' menu'); if (open) { const r = el.getBoundingClientRect(); menu.style.left = r.left + window.scrollX + 'px'; menu.style.top = r.bottom + window.scrollY + 'px' } return }
    if (el.dataset.sortDir) {
      const c = L.indexOf(st.menuCol); const dir = el.dataset.sortDir
      const rows = data.slice(1).sort((a, b) => ((num(a[c]) && num(b[c])) ? Number(a[c]) - Number(b[c]) : String(a[c] || '').localeCompare(String(b[c] || ''))) * (dir === 'asc' ? 1 : -1))
      data.splice(1, data.length - 1, ...rows)
      for (const k of Object.keys(st.effects)) if (k.startsWith('sort:')) delete st.effects[k]
      st.effects['sort:' + st.menuCol + ':' + dir] = true
      status('Sorted by column ' + st.menuCol + ', ' + (dir === 'asc' ? 'A to Z' : 'Z to A') + '.')
      st.menuCol = null; menu.hidden = true
      if (st.picked.cell) select(st.picked.cell); else draw()
      return
    }
    if (el.dataset.addRow !== undefined) { data.push(L.map(() => '')); st.effects.rowAdded = true; select('A' + data.length); status('Row ' + data.length + ' added.'); return }
  })
  draw()
})()`

function done(t, state) {
  if (t.type === 'any') return t.of.some((test) => flowStepDone({ test }, state))
  if (t.type === 'picked') return flowStepDone({ test: t }, state)
  if (t.type === 'cellTyped') return Boolean(state.effects[t.key]) || (state.picked.cell === t.cell && state.values[t.fx] === t.value)
  return false
}

/** Name box: type the ref, then Enter. Formula bar: type the value, then Enter. Menus: open, then pick. */
function actions(spec, a, state) {
  const nb = spec.nameBoxId; const fx = spec.fxId
  switch (a.kind) {
    case 'goto': return state.values[nb] === a.ref && state.focused === nb ? ['press("Enter")'] : [`type(@${nb},${JSON.stringify(a.ref)})`]
    case 'fx': return [`type(@${fx},${JSON.stringify(a.value)})`]
    case 'commit': return state.focused === fx && state.values[fx] === a.value ? ['press("Enter")'] : [`type(@${fx},${JSON.stringify(a.value)})`]
    case 'menu': return state.menuCol === a.col ? [`click(@${a.item})`] : [`click(@${spec.colMenuIds[a.col]})`]
    default: return []
  }
}

export const sheetFlow = { spec: sheetSpec, render: renderSheet, css, runtime, done, actions }
