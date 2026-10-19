// NocoDB 0.258 (last DOM-rendered grid) on tables.farm.test: an Airtable-like app. Seed: seed/nocodb_seed.py
// (6 bases, 12 tables, 1,446 rows: CRM leads, inventory, content calendar, hiring, projects, events).
// Records are edited the Airtable way: select a cell, Space opens the expanded record, edit, Save Record.
// State is read from NocoDB's postgres DB (farm_nocodb: meta tables nc_*_v2, data in one schema per base).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`
const q = (sh, sql) => sh(`su postgres -c "psql -d farm_nocodb -qAt -F '\t'"`, { input: sql, stdio: ['pipe', 'pipe', 'pipe'] })
  .split('\n').filter((l) => l.length).map((l) => l.split('\t'))
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Tables with their columns (title, column_name, uidt) and grid view id. Cached: ids survive a reset (template copy). */
let META = null
// A fresh query string forces a full page load, so popups left by an earlier episode are gone.
let LOADS = 0
function meta(sh) {
  if (META) return META
  META = {}
  for (const [id, base, title, tname] of q(sh, `select id, base_id, title, table_name from nc_models_v2 where title <> 'Features'`)) {
    const cols = q(sh, `select id, title, column_name, uidt from nc_columns_v2 where fk_model_id = ${lit(id)} and coalesce(system, false) = false
      and uidt not in ('ID', 'CreatedTime', 'LastModifiedTime', 'CreatedBy', 'LastModifiedBy', 'Order') order by "order"`).map(([cid, t, c, u]) => ({ id: cid, title: t, col: c, uidt: u }))
    const view = q(sh, `select id from nc_views_v2 where fk_model_id = ${lit(id)} order by created_at limit 1`)[0][0]
    META[title] = { id, base, title, table: `"${base}"."${tname}"`, cols, view, path: `/dashboard/#/nc/${base}/${id}` }
    Object.defineProperty(META[title], 'path', { get: () => `/dashboard/?v=${++LOADS}#/nc/${base}/${id}` })
  }
  return META
}
const BASE_OF = { Leads: 'Sales CRM', Accounts: 'Sales CRM', Products: 'Inventory', Suppliers: 'Inventory', Posts: 'Content Calendar', Writers: 'Content Calendar',
  Openings: 'Hiring', Candidates: 'Hiring', Tasks: 'Projects', Milestones: 'Projects', Events: 'Events', Attendees: 'Events' }
const SMALL = ['Accounts', 'Suppliers', 'Writers', 'Openings', 'Milestones', 'Events']
/** All rows of a table as objects keyed by column title (id under `_id`), in id order (= grid order). */
function rows(sh, t) {
  const m = meta(sh)[t]
  return q(sh, `select id, ${m.cols.map((c) => `coalesce("${c.col}"::text, '')`).join(', ')} from ${m.table} order by id`)
    .map((r) => Object.fromEntries([['_id', r[0]], ...m.cols.map((c, i) => [c.title, r[i + 1]])]))
}
const primary = (sh, t) => meta(sh)[t].cols[0].title
const editable = (sh, t) => meta(sh)[t].cols.slice(1).filter((c) => ['SingleLineText', 'Number', 'Email', 'Decimal', 'PhoneNumber'].includes(c.uidt))
const shown = (v, uidt) => (uidt === 'Decimal' ? Number(v).toFixed(1) : v)
/** A record in the first rows (the grid renders ~50) whose primary value is unique. */
function pickRecord(rng, sh, t, limit = 25) {
  const all = rows(sh, t); const p = primary(sh, t)
  for (let i = 0; i < 20; i++) {
    const r = rng.pick(all.slice(0, limit))
    if (all.filter((x) => x[p] === r[p]).length === 1 && r[p]) return { r, p, all }
  }
  return null
}
const fieldBox = (title) => ({ role: /^(textbox|spinbutton)$/, inside: new RegExp(`^${esc(title)}\\b`), insideDepth: 1 })
const openRecord = (p, value, plan = 1) => [
  { plan, do: 'click', target: { role: 'cell', name: value }, mayNotChange: true, settle: 600 },
  { plan, do: 'press', key: 'Space', settle: 1800 }
]
const newValue = (rng, c, old) => {
  if (c.uidt === 'Number') return String(Math.max(0, Number(old || 0) + rng.pick([-1, 1]) * rng.int(1, 50) * (Number(old) > 100000 ? 10000 : 1)))
  if (c.uidt === 'Decimal') return String(Number(old || 0) + 0.5)
  if (c.uidt === 'Email') return `${rng.pick(['team', 'hello', 'ops', 'sales'])}@${rng.pick(['acme', 'globex', 'initech'])}.test`
  if (c.uidt === 'PhoneNumber') return `+91 98${rng.int(10000000, 99999999)}`
  return rng.pick(['Mumbai', 'Pune', 'Remote', 'Kochi', 'Platform', 'Growth', 'Data', 'Rohan Iyer', 'Meera Nair', 'Lisbon', 'Berlin', 'Sales'])
}

const tasks = {
  // Edit one field of a record via the expanded record.
  edit_field: async ({ rng, sh }) => {
    const t = rng.pick(Object.keys(BASE_OF))
    const pick = pickRecord(rng, sh, t); if (!pick) return null
    const { r, p } = pick
    const c = rng.pick(editable(sh, t)); if (!c) return null
    const v = newValue(rng, c, r[c.title]); if (v === r[c.title]) return null
    return {
      goal: rng.pick([`In ${t}, change the ${c.title} of ${r[p]} to ${v}.`, `Update ${r[p]}'s ${c.title} to ${v} in the ${BASE_OF[t]} base.`,
        `Set ${c.title} = ${v} for the record "${r[p]}" in ${t}.`]),
      start: meta(sh)[t].path, startWait: 4000,
      plan: [{ title: `Open the record ${r[p]}`, check: `the expanded record shows ${r[p]}` }, { title: `Set ${c.title} to ${v}`, check: `textbox "${c.title}" = ${v}` },
        { title: 'Save the record', check: 'the record is saved' }],
      steps: [...openRecord(p, r[p]), { plan: 2, do: 'type', target: fieldBox(c.title), text: v },
        { plan: 3, do: 'click', target: { role: 'button', name: 'Save Record' }, settle: 2000 }],
      answer: `${r[p]}: ${c.title} is now ${v}.`,
      verify: async ({ sh }) => { const m = meta(sh)[t]; const got = q(sh, `select coalesce("${c.col}"::text,'') from ${m.table} where id = ${r._id}`)[0]?.[0]; return got != null && (got === v || Number(got) === Number(v)) }
    }
  },

  // Add a record to a small table with the expanded form.
  add_record: async ({ rng, sh }) => {
    const t = rng.pick(SMALL)
    const m = meta(sh)[t]; const p = m.cols[0]
    const name = { Accounts: () => `${rng.pick(['Nova', 'Pixel', 'Terra', 'Sundial', 'Bright', 'Kite', 'Lumen'])} ${rng.pick(['Labs', 'Foods', 'Logistics', 'Health', 'Media', 'Systems'])}`,
      Suppliers: () => `${rng.pick(['Patel', 'Gill', 'Rao', 'Silva', 'Meyer'])} ${rng.pick(['Traders', 'Supplies', 'Imports'])} ${rng.pick(['India', 'Co', 'LLP'])}`,
      Writers: () => `${rng.pick(['Asha', 'Vikram', 'Lena', 'Joel', 'Tara'])} ${rng.pick(['Pandey', 'Lobo', 'Hart', 'Saxena'])}`,
      Openings: () => rng.pick(['Mobile Engineer', 'Security Engineer', 'Content Writer', 'Account Manager', 'Data Engineer', 'UX Researcher']),
      Milestones: () => `${rng.pick(['Atlas', 'Beacon', 'Comet'])} ${rng.pick(['launch', 'pilot', 'v2 beta', 'security review'])}`,
      Events: () => `${rng.pick(['Partner', 'Customer', 'Founder'])} ${rng.pick(['Breakfast', 'Roundtable', 'Hackday'])} ${rng.pick(['Goa', 'Kochi', 'Indore', 'Mysuru'])}` }[t]()
    if (rows(sh, t).some((x) => x[p.title] === name)) return null
    const extra = m.cols.slice(1).filter((c) => ['SingleLineText', 'Number', 'Email'].includes(c.uidt)).slice(0, 2)
    const vals = extra.map((c) => [c, c.uidt === 'Number' ? String(rng.int(2, 900)) : c.uidt === 'Email' ? `${name.split(' ')[0].toLowerCase()}@new.test` : newValue(rng, c, '')])
    const desc = [`${p.title} ${name}`, ...vals.map(([c, v]) => `${c.title} ${v}`)].join(', ')
    const steps = [{ plan: 1, do: 'click', target: { role: 'button', name: /New record$/ }, settle: 1500 }, { plan: 1, do: 'press', key: 'Space', settle: 1800 },
      { plan: 2, do: 'type', target: fieldBox(p.title), text: name }, ...vals.map(([c, v]) => ({ plan: 2, do: 'type', target: fieldBox(c.title), text: v })),
      { plan: 3, do: 'click', target: { role: 'button', name: 'Save Record' }, settle: 2000 }]
    return {
      goal: rng.pick([`Add a record to ${t}: ${desc}.`, `In the ${BASE_OF[t]} base, create a new ${t.replace(/s$/, '').toLowerCase()} with ${desc}.`, `New row in ${t} — ${desc}.`]),
      start: m.path, startWait: 4000,
      plan: [{ title: 'Add a new record and open it', check: 'an empty expanded record' }, { title: `Fill in ${desc}`, check: `textbox "${p.title}" = ${name}` },
        { title: 'Save the record', check: 'the record is saved' }],
      steps,
      answer: `Added ${name} to ${t}.`,
      verify: async ({ sh }) => { const got = rows(sh, t).filter((x) => x[p.title] === name); return got.length === 1 && vals.every(([c, v]) => got[0][c.title] === v || Number(got[0][c.title]) === Number(v)) }
    }
  },

  // Delete a record from the row's right-click menu.
  delete_record: async ({ rng, sh }) => {
    const t = rng.pick(Object.keys(BASE_OF))
    const pick = pickRecord(rng, sh, t, 20); if (!pick) return null
    const { r, p } = pick
    return {
      goal: rng.pick([`Delete the record ${r[p]} from ${t}.`, `Remove "${r[p]}" from the ${t} table.`, `In ${BASE_OF[t]}, delete ${r[p]} from ${t}.`]),
      start: meta(sh)[t].path, startWait: 4000,
      plan: [{ title: `Open the menu of the ${r[p]} row`, check: 'menuitem "Delete record"' }, { title: 'Click Delete record', check: `${r[p]} is gone` }],
      steps: [{ plan: 1, do: 'rightclick', target: { role: 'cell', name: r[p] } },
        { plan: 2, do: 'click', target: { role: /menuitem|generic|listitem/, text: /^Delete record$/, nth: 999 }, settle: 2500 }],
      answer: `Deleted ${r[p]}.`,
      verify: async ({ sh }) => !q(sh, `select 1 from ${meta(sh)[t].table} where id = ${r._id}`).length
    }
  },

  // Sort the grid by a field.
  sort_view: async ({ rng, sh }) => {
    const t = rng.pick(Object.keys(BASE_OF))
    const m = meta(sh)[t]
    const c = rng.pick(m.cols.filter((x) => ['SingleLineText', 'Number', 'Date', 'Decimal'].includes(x.uidt)))
    const desc = rng.chance(0.5)
    const num = ['Number', 'Decimal'].includes(c.uidt)
    const [up, down] = num ? ['1 → 9', '9 → 1'] : c.uidt === 'Date' ? ['1 → 9', '9 → 1'] : ['A → Z', 'Z → A']
    const steps = [{ plan: 1, do: 'click', target: { role: 'button', name: 'Sort' } },
      { plan: 1, do: 'click', target: { role: 'generic', text: new RegExp(`^${esc(c.title)}$`), nth: 999 }, settle: 1500 }]
    if (desc) steps.push({ plan: 2, do: 'click', target: { role: 'generic', text: new RegExp(`^${esc(up)}$`), nth: 999 }, mayNotChange: true },
      { plan: 2, do: 'click', target: { role: 'generic', text: new RegExp(`^${esc(down)}$`), nth: 999 }, settle: 1500 })
    return {
      goal: rng.pick([`Sort ${t} by ${c.title}${desc ? ', highest / latest / Z first' : ''}.`, `Order the ${t} grid by ${c.title} (${desc ? 'descending' : 'ascending'}).`]),
      start: m.path, startWait: 4000,
      plan: [{ title: `Add a sort on ${c.title}`, check: `the grid is sorted by ${c.title}` }, ...(desc ? [{ title: `Switch it to ${down}`, check: `text "${down}"` }] : [])],
      steps,
      answer: `${t} is sorted by ${c.title} ${desc ? 'descending' : 'ascending'}.`,
      verify: async ({ sh }) => q(sh, `select direction from nc_sort_v2 where fk_view_id = ${lit(m.view)} and fk_column_id = ${lit(c.id)}`)[0]?.[0] === (desc ? 'desc' : 'asc')
    }
  },

  // Filter the grid to a record and read a field (the filter stays on the view).
  filter_read: async ({ rng, sh }) => {
    const t = rng.pick(['Leads', 'Products', 'Posts', 'Candidates', 'Tasks', 'Attendees'])
    const all = rows(sh, t); const p = primary(sh, t)
    const r = rng.pick(all); if (all.filter((x) => x[p] === r[p]).length > 1) return null
    const c = rng.pick(meta(sh)[t].cols.slice(1).filter((x) => !['Checkbox'].includes(x.uidt))); if (!r[c.title]) return null
    return {
      goal: rng.pick([`What is the ${c.title} of ${r[p]} in ${t}? Use a filter to find it.`, `Filter ${t} to "${r[p]}" and tell me its ${c.title}.`, `Find ${r[p]} in the ${BASE_OF[t]} base (${t}) and read the ${c.title}.`]),
      start: meta(sh)[t].path, startWait: 4000,
      plan: [{ title: 'Open Filter and add a filter', check: 'a filter row' }, { title: `Filter ${p} is equal to ${r[p]}`, check: `cell "${r[p]}"` }],
      steps: [{ plan: 1, do: 'click', target: { role: 'button', name: 'Filter' } }, { plan: 1, do: 'click', target: { role: 'button', name: 'add Add filter' }, settle: 1500 },
        { plan: 2, do: 'type', target: { role: 'textbox', inside: /^Where/, insideDepth: 2 }, text: r[p], settle: 2500 }],
      answer: `${r[p]}: ${c.title} = ${r[c.title]}.`,
      verify: async ({ sh }) => q(sh, `select value from nc_filter_exp_v2 where fk_view_id = ${lit(meta(sh)[t].view)}`).some(([v]) => v === r[p])
    }
  },

  // Hide a field in the grid.
  hide_field: async ({ rng, sh }) => {
    const t = rng.pick(Object.keys(BASE_OF))
    const m = meta(sh)[t]
    const c = rng.pick(m.cols.slice(1))
    return {
      goal: rng.pick([`Hide the ${c.title} field in the ${t} grid.`, `I do not need the ${c.title} column in ${t}. Hide it.`]),
      start: m.path, startWait: 4000,
      plan: [{ title: 'Open the Fields menu', check: 'textbox "Search fields"' }, { title: `Switch off ${c.title}`, check: `${c.title} is hidden` }],
      steps: [{ plan: 1, do: 'click', target: { role: 'button', name: 'Fields' } },
        { plan: 2, do: 'click', target: { role: 'switch', inside: new RegExp(`^${esc(c.title)}$`), insideDepth: 1 }, settle: 1500 }],
      answer: `${c.title} is hidden in ${t}.`,
      verify: async ({ sh }) => q(sh, `select show from nc_grid_view_columns_v2 where fk_view_id = ${lit(m.view)} and fk_column_id = ${lit(c.id)}`)[0]?.[0] === 'f'
    }
  },

  // Add a new field (column) to a table.
  add_column: async ({ rng, sh }) => {
    const t = rng.pick(Object.keys(BASE_OF))
    const m = meta(sh)[t]
    const name = rng.pick(['Notes', 'Owner Email', 'Region', 'Priority Level', 'Reviewed By', 'Tags', 'Comments', 'Budget Code', 'Follow-up Owner'])
    if (m.cols.some((c) => c.title === name)) return null
    return {
      goal: rng.pick([`Add a text field called "${name}" to ${t}.`, `Create a new column "${name}" in the ${t} table.`]),
      start: m.path, startWait: 4000,
      plan: [{ title: 'Open the table details', check: 'tab "Fields"' }, { title: `Add a new field named ${name}`, check: `textbox "Field name (Optional)" = ${name}` },
        { title: 'Save changes', check: `text "${name}"` }],
      steps: [{ plan: 1, do: 'click', target: { role: 'generic', text: /^Details$/ }, settle: 2000 },
        { plan: 2, do: 'click', target: { role: 'button', name: 'add New field' } },
        { plan: 2, do: 'type', target: { role: 'textbox', name: 'Field name (Optional)' }, text: name },
        { plan: 3, do: 'click', target: { role: 'button', name: 'Save changes' }, settle: 2500 }],
      answer: `Added the field "${name}" to ${t}.`,
      verify: async ({ sh }) => q(sh, `select 1 from nc_columns_v2 where fk_model_id = ${lit(m.id)} and title = ${lit(name)}`).length === 1
    }
  },

  // Read a value from a small table (click the cell).
  read_cell: async ({ rng, sh }) => {
    const t = rng.pick(SMALL)
    const pick = pickRecord(rng, sh, t, 30); if (!pick) return null
    const { r, p } = pick
    const c = rng.pick(meta(sh)[t].cols.slice(1).filter((x) => ['SingleLineText', 'Number', 'Date', 'SingleSelect', 'Decimal'].includes(x.uidt)))
    const v = r[c.title]; if (!v) return null
    const row = { role: 'row', text: new RegExp(`^\\d+ ${esc(r[p])} `) }
    return {
      goal: rng.pick([`What is the ${c.title} of ${r[p]} in ${t}?`, `Look up ${r[p]} in the ${BASE_OF[t]} base and tell me the ${c.title}.`]),
      start: meta(sh)[t].path, startWait: 4000, writes: false,
      plan: [{ title: `Find ${r[p]} and select its ${c.title} cell`, check: `the ${c.title} of ${r[p]} is visible` }],
      steps: [{ plan: 1, do: 'click', target: { role: 'cell', name: r[p] }, mayNotChange: true }],
      answer: `${r[p]}: ${c.title} = ${shown(v, c.uidt)}.`,
      verify: async ({ sh }) => rows(sh, t).find((x) => x._id === r._id)?.[c.title] === v && Boolean(row)
    }
  }
}

export default {
  name: 'nocodb',
  family: 'tables',
  origin: 'http://tables.farm.test',
  portOffset: 32,
  explorePaths: ['/dashboard/'],
  async reset({ sh }) { sh('bash /workspace/clone-farm/nocodb/reset.sh') },
  async login({ page, sleep }) {
    await page.goto('http://tables.farm.test/dashboard/#/signin'); await sleep(3000)
    if (!/signin/.test(page.url())) return
    await page.fill('input[type=email], input[name=email], #email', 'farmadmin@farm.test')
    await page.fill('input[type=password]', ACCOUNTS.password)
    await page.click('button[type=submit]')
    await page.waitForURL((u) => !/signin/.test(String(u)), { timeout: 30_000 }); await sleep(2000)
  },
  // A task returns null when the random pick does not fit (ties, duplicates): try a few picks.
  tasks: Object.fromEntries(Object.entries(tasks).map(([k, fn]) => [k, async (ctx) => { for (let i = 0; i < 12; i++) { const s = await fn(ctx); if (s) return s } return null }]))
}
