// EtherCalc (SocialCalc grid, real DOM cells) on sheets.farm.test: a Google-Sheets-like editor. Seed: seed/ethercalc_seed.py
// (45 sheets: budgets, regional sales, inventory, expenses, grades; formulas for variance, value, average).
// Cells are edited the formula-bar way: click the cell, click the input line, type, Enter.
// State is read with EtherCalc's own REST API (/_/<room>/csv and /_/<room>/cells/<coord>).
const API = 'http://127.0.0.1:7130'
const COLS = 'ABCDEFGHIJKLMNOPQ'

const parseCsv = (text) => {
  const rows = []; let row = []; let cur = ''; let q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') q = false; else cur += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
    else if (c !== '\r') cur += c
  }
  if (cur || row.length) { row.push(cur); rows.push(row) }
  return rows
}
const csv = (sh, room) => parseCsv(sh(`curl -sf ${API}/_/${room}/csv`))
const cell = (sh, room, coord) => { try { return JSON.parse(sh(`curl -sf ${API}/_/${room}/cells/${coord}`)) } catch { return {} } }
let ROOMS = null
const rooms = (sh) => (ROOMS ??= sh('ls /workspace/clone-farm/snap/ethercalc').trim().split('\n').map((f) => f.replace(/\.sc$/, '')))
const pickRoom = (rng, sh, re) => rng.pick(rooms(sh).filter((r) => re.test(r)))
/** Seed table of a room: header, data rows (no Total row), and whether a Total row follows. */
function table(sh, room) {
  const all = csv(sh, room).filter((r) => r.some((v) => v !== ''))
  const header = all[0]
  const total = all.at(-1)[0] === 'Total'
  return { header, rows: all.slice(1, total ? -1 : undefined), total, width: header.length }
}
const coordOf = (col, row) => `${COLS[col]}${row}`
const nice = (room) => room
const num = (v) => (v === '' || v == null ? '' : Number(v))
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// CSV export shows dates as 13-Jul-2026; typed ISO dates must match that.
const isoToCsv = (v) => { const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? `${Number(m[3])}-${MON[Number(m[2]) - 1]}-${m[1]}` : null }
const same = (a, b) => String(a) === String(b) || isoToCsv(b) === String(a) || isoToCsv(a) === String(b) || (a !== '' && b !== '' && Math.abs(Number(a) - Number(b)) < 1e-6)

// Grid targets: the row is found by its row-number header cell, the column by position (A = 2nd cell of the row).
const rowRe = (r) => new RegExp(`^${r}(\\s|$)`)
const gridCell = (col, row) => ({ role: 'cell', inside: rowRe(row), insideRole: 'row', insideDepth: 1, nth: col + 1, only: true })
const inputLine = { role: 'textbox', name: '', only: true }

/** Steps that write one value into a cell the formula-bar way. */
const writeCell = (plan, col, row, text, last = 'Enter') => [
  { plan, do: 'click', target: gridCell(col, row), mayNotChange: true, settle: 600 },
  { plan, do: 'click', target: inputLine, mayNotChange: true, settle: 500 },
  { plan, do: 'type', target: inputLine, text, settle: 500 },
  { plan, do: 'press', key: last, settle: 1500 }
]

/** Last grid row fully visible (rows are 28 px; the grid starts ~400 px down). Off-screen cells get scrolled into
 * view by the click, and SocialCalc then maps the click to the wrong cell. */
const maxRow = (page) => Math.floor(((page?.viewportSize()?.height ?? 768) - 400) / 28)

const WORDS = ['Pending', 'Done', 'Review', 'Approved', 'On hold', 'TBD', 'Check', 'Paid', 'Ordered', 'Late']

const tasks = {
  // D1: put a value in a given cell.
  set_cell: async ({ rng, sh, page }) => {
    const room = rng.pick(rooms(sh))
    const t = table(sh, room)
    const col = rng.int(0, Math.min(t.width + 1, 6))
    const row = rng.int(2, Math.min(t.rows.length + 4, maxRow(page)))
    const coord = coordOf(col, row)
    const value = rng.chance(0.6) ? String(rng.int(1, 9999)) : rng.pick(WORDS)
    return {
      goal: rng.pick([`Put ${value} in cell ${coord} of the sheet ${nice(room)}.`, `In ${nice(room)}, set cell ${coord} to ${value}.`,
        `Type ${value} into ${coord} on the ${nice(room)} spreadsheet.`]),
      start: `/${room}`,
      plan: [{ title: `Select cell ${coord}`, check: `cell ${coord} is selected` }, { title: `Type ${value} and press Enter`, check: `cell ${coord} shows ${value}` }],
      steps: writeCell(1, col, row, value).map((s, i) => ({ ...s, plan: i === 0 ? 1 : 2 })),
      answer: `Cell ${coord} is now ${value}.`,
      verify: async ({ sh }) => same(cell(sh, room, coord).datavalue ?? '', value)
    }
  },

  // Change one value in the row of a named item.
  edit_item: async ({ rng, sh, page }) => {
    const room = pickRoom(rng, sh, /^(inventory|grades|budget|sales)/)
    const t = table(sh, room)
    const keyCol = room.startsWith('inventory') ? 1 : 0
    const r = rng.int(0, Math.min(t.rows.length, maxRow(page) - 1) - 1)
    const item = t.rows[r][keyCol]
    if (t.rows.filter((x) => x[keyCol] === item).length > 1) return null
    const editable = room.startsWith('inventory') ? [2, 3] : room.startsWith('grades') ? [1, 2, 3] : room.startsWith('budget') ? [1, 2] : [2, 3]
    const col = rng.pick(editable)
    const value = String(Number(t.rows[r][col]) + rng.pick([-1, 1]) * rng.int(1, 40))
    if (Number(value) < 0) return null
    const what = t.header[col]
    const coord = coordOf(col, r + 2)
    return {
      goal: rng.pick([`In ${nice(room)}, change the ${what} of ${item} to ${value}.`, `Update ${item}'s ${what} to ${value} in the sheet ${nice(room)}.`,
        `The ${what} for ${item} in ${nice(room)} should be ${value}. Fix it.`]),
      start: `/${room}`,
      plan: [{ title: `Select the ${what} cell of ${item} (${coord})`, check: `cell ${coord} is selected` }, { title: `Type ${value} and press Enter`, check: `cell ${coord} shows ${value}` }],
      steps: writeCell(1, col, r + 2, value).map((s, i) => ({ ...s, plan: i === 0 ? 1 : 2 })),
      answer: `${item}'s ${what} is now ${value}.`,
      verify: async ({ sh }) => same(cell(sh, room, coord).datavalue ?? '', value)
    }
  },

  // D2: add a row with given values at the end of the table.
  add_row: async ({ rng, sh, page }) => {
    const room = pickRoom(rng, sh, /^(sales|expenses)/)
    const t = table(sh, room)
    const row = t.rows.length + 2
    if (row > maxRow(page)) return null
    let values
    if (room.startsWith('sales')) {
      const units = rng.int(10, 400)
      values = [`${rng.pick(['Asha', 'Vivek', 'Lena', 'Joel', 'Mira', 'Tariq', 'Ruth', 'Kiran'])} ${rng.pick(['Pandey', 'Ghosh', 'Lobo', 'Hart', 'Saxena', 'Quinn'])}`, t.rows[0][1], String(units), String(units * rng.pick([850, 1200, 1499]))]
    } else {
      const m = room.includes('july') ? '07' : room.includes('august') ? '08' : '09'
      values = [`2026-${m}-${String(rng.int(1, 28)).padStart(2, '0')}`, rng.pick(['Cab to client office', 'Team dinner', 'Stationery', 'Workshop venue', 'Parking', 'Cloud credits']),
        rng.pick(['Travel', 'Meals', 'Office', 'Training', 'Software']), String(rng.int(15, 1500) * 10)]
    }
    const steps = []
    values.forEach((v, c) => steps.push(...writeCell(c + 1, c, row, v).map((s) => ({ ...s, plan: 1 }))))
    return {
      goal: rng.pick([`Add a row at the end of ${nice(room)} with ${values.join(', ')}.`, `Append ${values.map((v, i) => `${t.header[i]} ${v}`).join(', ')} as a new row in ${nice(room)}.`,
        `In the sheet ${nice(room)}, add a new last row: ${values.join(' | ')}.`]),
      start: `/${room}`,
      plan: [{ title: `Fill row ${row}: ${values.join(', ')}`, check: `row ${row} shows ${values[0]}` }],
      steps,
      answer: `Added row ${row}: ${values.join(', ')}.`,
      verify: async ({ sh }) => { const got = csv(sh, room)[row - 1] ?? []; const ok = values.every((v, i) => same(got[i] ?? '', v)); if (!ok && process.env.DEBUG_VERIFY) console.log("add_row", room, row, values, got); return ok }
    }
  },

  // D3: write a SUM (or AVERAGE / MAX) formula under a column.
  column_formula: async ({ rng, sh, page }) => {
    const room = pickRoom(rng, sh, /^(sales|expenses|grades|inventory)/)
    const t = table(sh, room)
    if (t.rows.length + 2 > maxRow(page)) return null
    const numeric = t.header.map((h, i) => i).filter((i) => i > 0 && t.rows.every((r) => r[i] !== '' && !Number.isNaN(Number(r[i]))) && !(room.startsWith('grades') && i === 4))
    if (!numeric.length) return null
    const col = rng.pick(numeric)
    const fn = room.startsWith('grades') ? rng.pick(['AVERAGE', 'MAX', 'MIN']) : rng.pick(['SUM', 'SUM', 'SUM', 'MAX'])
    const L = COLS[col]; const last = t.rows.length + 1; const row = last + 1
    const vals = t.rows.map((r) => Number(r[col]))
    const expect = fn === 'SUM' ? vals.reduce((a, b) => a + b, 0) : fn === 'MAX' ? Math.max(...vals) : fn === 'MIN' ? Math.min(...vals) : vals.reduce((a, b) => a + b, 0) / vals.length
    const formula = `=${fn}(${L}2:${L}${last})`
    const word = { SUM: 'total', MAX: 'highest value', MIN: 'lowest value', AVERAGE: 'average' }[fn]
    return {
      goal: rng.pick([`In ${nice(room)}, write the ${word} of the ${t.header[col]} column under it with a formula.`, `Add a ${fn} formula below the ${t.header[col]} column in ${nice(room)}.`,
        `Under ${t.header[col]} in the sheet ${nice(room)}, put a formula that gives the ${word}.`]),
      start: `/${room}`,
      plan: [{ title: `Select ${L}${row}, the first empty cell under ${t.header[col]}`, check: `cell ${L}${row} is selected` }, { title: `Type ${formula} and press Enter`, check: `cell ${L}${row} shows the ${word}` }],
      steps: writeCell(1, col, row, formula).map((s, i) => ({ ...s, plan: i === 0 ? 1 : 2 })),
      answer: `${L}${row} = ${formula} (${Math.round(expect * 100) / 100}).`,
      verify: async ({ sh }) => { const c = cell(sh, room, `${L}${row}`); return /^(SUM|MAX|MIN|AVERAGE)\(/i.test(c.formula ?? '') && Math.abs(Number(c.datavalue) - expect) < 0.01 }
    }
  },

  // D5: read the value in the row of a named item.
  read_value: async ({ rng, sh, page }) => {
    const room = pickRoom(rng, sh, /^(inventory|grades|budget|sales)/)
    const t = table(sh, room)
    const keyCol = room.startsWith('inventory') ? 1 : 0
    const r = rng.int(0, Math.min(t.rows.length, maxRow(page) - 1) - 1)
    const item = t.rows[r][keyCol]
    if (t.rows.filter((x) => x[keyCol] === item).length > 1) return null
    const col = rng.pick(t.header.map((h, i) => i).filter((i) => i !== keyCol && i > 0))
    const what = t.header[col]; const value = t.rows[r][col]; const coord = coordOf(col, r + 2)
    return {
      goal: rng.pick([`What is the ${what} of ${item} in ${nice(room)}?`, `Look up ${item}'s ${what} in the sheet ${nice(room)}.`, `In ${nice(room)}, read the ${what} for ${item}.`]),
      start: `/${room}`, writes: false,
      plan: [{ title: `Select the ${what} cell of ${item} (${coord})`, check: `the input line shows ${value}` }],
      steps: [{ plan: 1, do: 'click', target: gridCell(col, r + 2), mayNotChange: true }],
      answer: `${item}: ${what} = ${value}.`,
      verify: async ({ sh }) => same(cell(sh, room, coord).datavalue ?? '', num(value))
    }
  },

  // Clear a cell with the toolbar.
  clear_cell: async ({ rng, sh, page }) => {
    const room = pickRoom(rng, sh, /^(sales|expenses|inventory|grades)/)
    const t = table(sh, room)
    const r = rng.int(0, Math.min(t.rows.length, maxRow(page) - 1) - 1)
    const col = rng.int(1, Math.min(t.width - 1, 3))
    const coord = coordOf(col, r + 2)
    if (t.rows[r][col] === '') return null
    return {
      goal: rng.pick([`Clear cell ${coord} in ${nice(room)}.`, `Delete the contents of ${coord} on the sheet ${nice(room)}.`, `Empty cell ${coord} (${t.header[col]} of ${t.rows[r][0]}) in ${nice(room)}.`]),
      start: `/${room}`,
      plan: [{ title: `Select cell ${coord}`, check: `cell ${coord} is selected` }, { title: 'Click Delete Cell Contents', check: `cell ${coord} is empty` }],
      steps: [{ plan: 1, do: 'click', target: gridCell(col, r + 2), mayNotChange: true }, { plan: 2, do: 'click', target: { role: 'img', name: 'Delete Cell Contents' }, settle: 1500 }],
      answer: `Cleared ${coord}.`,
      verify: async ({ sh }) => (cell(sh, room, coord).datavalue ?? '') === ''
    }
  },

  // Delete the row of a named item.
  delete_row: async ({ rng, sh, page }) => {
    const room = pickRoom(rng, sh, /^(sales|expenses|inventory|grades)/)
    const t = table(sh, room)
    const keyCol = room.startsWith('inventory') ? 1 : room.startsWith('expenses') ? 1 : 0
    const r = rng.int(0, Math.min(t.rows.length, maxRow(page) - 1) - 1)
    const item = t.rows[r][keyCol]
    if (t.rows.filter((x) => x[keyCol] === item).length > 1) return null
    return {
      goal: rng.pick([`Delete the row for ${item} in ${nice(room)}.`, `Remove ${item} from the sheet ${nice(room)} (the whole row).`, `In ${nice(room)}, delete row ${r + 2} (${item}).`]),
      start: `/${room}`,
      plan: [{ title: `Select a cell in the row of ${item} (row ${r + 2})`, check: `a cell of row ${r + 2} is selected` }, { title: 'Click Delete Row', check: `${item} is gone` }],
      steps: [{ plan: 1, do: 'click', target: gridCell(keyCol, r + 2), mayNotChange: true }, { plan: 2, do: 'click', target: { role: 'img', name: 'Delete Row' }, settle: 1500 }],
      answer: `Deleted the row for ${item}.`,
      verify: async ({ sh }) => { const got = csv(sh, room); return !got.some((x) => x[keyCol] === item) && got.filter((x) => x.some((v) => v !== '')).length === t.rows.length + (t.total ? 1 : 0) }
    }
  },

  // D4: sort the table by a column (drag-select the data, Sort tab, choose column and direction, Sort).
  sort_table: async ({ rng, sh, page }) => {
    const room = pickRoom(rng, sh, /^(sales|expenses|inventory|grades)/)
    const t = table(sh, room)
    if (t.rows.length + 1 > maxRow(page)) return null
    const col = rng.pick(t.header.map((h, i) => i).filter((i) => !(room.startsWith('inventory') && i === 4) && !(room.startsWith('grades') && i === 4)))
    const down = rng.chance(0.5)
    const last = t.rows.length + 1
    const lastCol = t.width - 1
    const range = `A2:${COLS[lastCol]}${last}`
    const key = (r) => (Number.isNaN(Number(r[col])) || r[col] === '' ? r[col].toLowerCase() : Number(r[col]))
    const sorted = [...t.rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0) * (down ? -1 : 1))
    if (sorted.length > 1 && key(sorted[0]) === key(sorted[1])) return null
    const first = sorted[0]
    const word = col === 0 && room.startsWith('expenses') ? (down ? 'newest first' : 'oldest first') : down ? 'largest / Z first (descending)' : 'smallest / A first (ascending)'
    return {
      goal: rng.pick([`Sort ${nice(room)} by ${t.header[col]}, ${word}. Keep the header row in place.`, `In ${nice(room)}, order the rows by the ${t.header[col]} column (${down ? 'descending' : 'ascending'}).`]),
      start: `/${room}`,
      plan: [{ title: `Select the data ${range}`, check: `${range} is selected` }, { title: 'Open the Sort tab and use the selection', check: `button "Sort ${range}"` },
        { title: `Choose column ${COLS[col]} ${down ? 'Down' : 'Up'} and sort`, check: `row 2 starts with ${first[0]}` }],
      steps: [
        // clone-capture resolves `to` as the first match (no nth): name the last cell by its text.
        { plan: 1, do: 'drag', target: gridCell(0, 2), to: { role: 'cell', name: t.rows.at(-1)[lastCol], inside: rowRe(last), insideRole: 'row', insideDepth: 1 }, mayNotChange: true },
        { plan: 2, do: 'click', target: { role: 'cell', name: 'Sort' } },
        { plan: 2, do: 'click', target: { role: 'button', name: 'OK' } },
        { plan: 3, do: 'select', target: { role: 'combobox', inside: /^Major Sort/, insideDepth: 2 }, value: `Column ${COLS[col]}`, mayNotChange: true },
        ...(down ? [{ plan: 3, do: 'click', target: { role: 'radio', inside: /^Up Down/, insideDepth: 1, nth: 1 }, mayNotChange: true }] : []),
        { plan: 3, do: 'click', target: { role: 'button', name: `Sort ${range}` }, settle: 2000, mayNotChange: true }
      ],
      answer: `Sorted ${room} by ${t.header[col]}; ${first[0]} is now first.`,
      verify: async ({ sh }) => { const got = csv(sh, room); return got[0][0] === t.header[0] && sorted.every((r, i) => (got[i + 1] ?? [])[0] === r[0]) }
    }
  }
}

export default {
  name: 'ethercalc',
  family: 'sheet',
  origin: 'http://sheets.farm.test',
  portOffset: 30,
  async reset({ sh }) { sh('bash /workspace/clone-farm/ethercalc/reset.sh') },
  async login({ page, sleep }) { await page.goto('http://sheets.farm.test/budget-hr-2026').catch(() => {}); await sleep(1500) },
  // A task returns null when the random pick does not fit (ties, duplicates): try a few picks.
  tasks: Object.fromEntries(Object.entries(tasks).map(([k, fn]) => [k, async (ctx) => { for (let i = 0; i < 12; i++) { const s = await fn(ctx); if (s) return s } return null }]))
}
