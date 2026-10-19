// Nextcloud 35 (Files, Calendar, Contacts, Deck, Notes, Text) on cloud.farm.test: a Google Drive / Calendar /
// Contacts / Trello-like suite. Seed: seed/nextcloud_seed.py; reset: farm/nextcloud/reset.sh (template DB + /dev/shm data).
// Every task reads its entities from the live DB at task time and verifies the result in the DB or the data dir.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
const ORIGIN = 'http://cloud.farm.test'
const DATA = '/dev/shm/clone-farm/nextcloud/data'
export const USER = 'asha.rao'

// ---------- helpers ----------
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Some dropdowns split words into spans ("In pro gress"): allow a space anywhere. */
const loose = (s) => new RegExp(`^${[...s.replace(/\s+/g, '')].map(esc).join('\\s?')}$`)
const b64 = (s) => Buffer.from(s).toString('base64')
/** Rows of a SQL query against the nextcloud DB ('|' separated). */
function q(sh, sql) {
  const out = sh(`echo ${b64(sql)} | base64 -d | su postgres -c "psql -d nextcloud -tAq -F '|'"`)
  return out.split('\n').filter(Boolean).map((l) => l.split('|'))
}
const one = (sh, sql) => (q(sh, sql)[0] ?? [])[0]
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`
const pick = (rng, a) => a[Math.floor(rng.next ? rng.next() * a.length : Math.random() * a.length)]
const R = (rng) => ({ pick: (a) => (rng.pick ? rng.pick(a) : pick(rng, a)), int: (lo, hi) => lo + Math.floor((rng.next ? rng.next() : Math.random()) * (hi - lo + 1)), chance: (p) => (rng.chance ? rng.chance(p) : Math.random() < p) })
const DIR_MIME = "(select id from oc_mimetypes where mimetype='httpd/unix-directory')"
const HOME = `(select numeric_id from oc_storages where id='home::${USER}')`

/** Asha's own files/folders as { path (relative to files/), name, parent, dir, fileid }. */
function entries(sh, where = 'true') {
  return q(sh, `select fileid, substr(path, 7), name, mimetype = ${DIR_MIME} from oc_filecache where storage = ${HOME} and path like 'files/%' and ${where}`)
    .map(([fileid, path, name, dir]) => ({ fileid, path, name, dir: dir === 't', parent: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '' }))
}
const exists = (sh, path) => one(sh, `select count(*) from oc_filecache where storage = ${HOME} and path = ${lit('files/' + path)}`) === '1'
const dirUrl = (parent) => `/apps/files/files?dir=/${encodeURIComponent(parent).replace(/%2F/g, '/')}`
const hidden = (e) => /^(Deck|Notes)(\/|$)|^Readme\.md$/.test(e.path)
const rowOf = (name) => ({ inside: new RegExp(`(View|Download|Open): ${esc(name)}|Open folder ${esc(name)}:`), insideRole: 'row' })

/** Steps to walk from All files into a folder by clicking folder names. */
function walk(parent, plan = 1) {
  if (!parent) return []
  return parent.split('/').map((seg) => ({ plan, do: 'click', target: { role: 'button', name: new RegExp(`^Open folder ${esc(seg)}:`) } }))
}

// Calendar: times shown/entered in IST (browser timezone Asia/Kolkata).
const IST_MS = 330 * 60_000
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const ist = (epoch) => new Date(epoch * 1000 + IST_MS) // read with getUTC*
const hm = (d) => `${((d.getUTCHours() + 11) % 12) + 1}:${String(d.getUTCMinutes()).padStart(2, '0')} ${d.getUTCHours() < 12 ? 'AM' : 'PM'}`
const longDate = (d) => `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${LONG_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
const isoDay = (d) => d.toISOString().slice(0, 10)
const TODAY = '2026-10-16'

function events(sh) {
  return q(sh, `select o.id, o.firstoccurence, o.lastoccurence, substring(convert_from(o.calendardata, 'UTF8') from 'SUMMARY:([^\\r\\n]*)'), c.uri, position('RRULE' in convert_from(o.calendardata, 'UTF8')) > 0, position('VALUE=DATE' in convert_from(o.calendardata, 'UTF8')) > 0
    from oc_calendarobjects o join oc_calendars c on c.id = o.calendarid where c.principaluri = 'principals/users/${USER}' and c.uri in ('work','personal') and o.deleted_at is null`)
    .map(([id, first, last, summary, cal, rrule, allday]) => ({ id, first: Number(first), last: Number(last), summary, cal, rrule: rrule === 't', allday: allday === 't' }))
}

function contacts(sh) {
  return q(sh, `select c.id, translate(encode(c.carddata, 'base64'), E'\\n', '') from oc_cards c join oc_addressbooks a on a.id = c.addressbookid where a.principaluri = 'principals/users/${USER}' and a.uri = 'contacts'`).map(([id, b]) => {
    const data = Buffer.from(b, 'base64').toString('utf8').replace(/\r/g, '')
    const get = (k) => (data.match(new RegExp(`^${k}[^:\\n]*:(.*)$`, 'm')) ?? [])[1]?.trim() ?? ''
    return { id, fn: get('FN'), org: get('ORG').replace(/;$/, ''), email: get('EMAIL'), tel: get('TEL'), title: get('TITLE'), tels: (data.match(/^TEL/gm) ?? []).length }
  }).filter((c) => c.fn && c.org)
}
const cardOf = (sh, fn) => q(sh, `select translate(encode(c.carddata, 'base64'), E'\\n', '') from oc_cards c join oc_addressbooks a on a.id = c.addressbookid where a.principaluri = 'principals/users/${USER}' and convert_from(c.carddata, 'UTF8') like ${lit('%FN:' + fn + '%')}`).map((r) => Buffer.from(r[0], 'base64').toString('utf8')).join('\n')

function deckCards(sh, where = 'true') {
  return q(sh, `select c.id, c.title, s.title, b.id, b.title, coalesce(to_char(c.duedate, 'YYYY-MM-DD HH24:MI'), ''), s.id from oc_deck_cards c join oc_deck_stacks s on s.id = c.stack_id join oc_deck_boards b on b.id = s.board_id
    where c.deleted_at = 0 and c.archived = false and s.deleted_at = 0 and b.deleted_at = 0 and b.owner = '${USER}' and b.title <> 'Welcome to Nextcloud Deck!' and ${where}`)
    .map(([id, title, stack, boardId, board, due, stackId]) => ({ id, title, stack, boardId, board, due, stackId }))
}
const stacksOf = (sh, boardId) => q(sh, `select id, title from oc_deck_stacks where board_id = ${boardId} and deleted_at = 0 order by "order"`).map(([id, title]) => ({ id, title }))
const boards = (sh) => q(sh, `select id, title from oc_deck_boards where owner = '${USER}' and deleted_at = 0 and title <> 'Welcome to Nextcloud Deck!'`).map(([id, title]) => ({ id, title }))

const NEW_FOLDERS = ['Q1 2027 planning', 'Vendor quotes', 'Board meeting', 'Old drafts', 'Receipts 2026', 'Client contracts', 'Design reviews', 'Team photos', 'Interview notes', 'Training material', 'Tax 2027', 'Launch assets', 'Research', 'Scans', 'Archive 2026', 'Personal']
const NEW_DOCS = [
  ['Meeting notes Atlas sync', 'Decisions: keep the launch date. Rohan to share the test plan.'],
  ['Offsite agenda', 'Day 1: strategy. Day 2: team games and dinner.'],
  ['Vendor comparison', 'BrightDesk is cheaper; Northwind has better support.'],
  ['Weekly status', 'Atlas on track. Data migration slightly behind.'],
  ['Ideas', 'Try a self-serve onboarding flow for small customers.'],
  ['Budget questions', 'Why did cloud spend go up in September?'],
  ['Hiring update', 'Two offers accepted, one pending.'],
  ['Travel checklist', 'Passport, charger, client gift, printed agenda.'],
  ['Release plan', 'Freeze on Monday, release on Thursday.'],
  ['Customer feedback', 'Bluefin Bank wants SSO and audit logs.'],
]
const NEW_EVENTS = ['Project kickoff', 'Coffee with Tara', 'Quarterly planning', 'Call with BrightDesk', 'Dentist checkup', 'Team lunch', 'Budget sync with Ritu', 'Interview debrief', 'Review Atlas demo', 'Yoga class', 'Parent meeting', 'Vendor demo: Northwind', 'Product roadmap review', 'Sprint planning', 'Pick up dry cleaning', 'Lunch with Rohan']
const NEW_PEOPLE = [['Kiran Desai', 'Lotus Health'], ['Fatima Sheikh', 'Bluefin Bank'], ['Rajesh Kumar', 'Orbit Retail'], ['Anita Bose', 'Kestrel Labs'], ['Marco Bianchi', 'Monsoon Media'], ['Suresh Pillai', 'AcmePay'],
  ['Lina Haddad', 'Greenleaf Catering'], ['Arvind Rao', 'SkyRoute Travels'], ['Chen Wei', 'PixelForge Studio'], ['Meghna Joshi', 'Northwind Traders'], ['Tomas Novak', 'BrightDesk'], ['Ayesha Siddiqui', 'Cloudnine Hosting']]
const NEW_CARDS = ['Update the FAQ page', 'Write onboarding email', 'Check SSL certificate expiry', 'Prepare demo data', 'Review vendor contract', 'Fix typo on pricing page', 'Plan team offsite', 'Collect customer quotes', 'Draft blog outline',
  'Book meeting room', 'Clean up old tickets', 'Test the export button', 'Schedule interviews', 'Order new laptops', 'Translate release notes']
const COMMENTS = ['Looks good, ship it.', 'Can we do this by Friday?', 'Blocked on legal review.', 'I will pick this up tomorrow.', 'Please add screenshots.', 'Done, please check.', 'Moving this to next sprint.', 'Waiting for the vendor reply.']
const phone = (r) => `+91 9${r.int(100, 999)}${r.int(100000, 999999)}`

const fileGoal = (r, name, parent) => r.pick([`Open the file "${name}"${parent ? ` in ${parent}` : ''}.`, `Show me ${name} from my drive.`, `Open ${name}${parent ? ` (it is in ${parent})` : ''}.`])

export default {
  name: 'nextcloud',
  family: 'cloud',
  origin: ORIGIN,
  portOffset: 10,
  explorePaths: ['/apps/files/files', '/apps/files/files?dir=/Projects', '/apps/calendar/', '/apps/contacts/', '/apps/deck/', '/apps/notes/'],
  async reset({ sh }) { sh('bash /workspace/clone-farm/nextcloud/reset.sh') },
  async login({ page, sleep }) {
    await page.context().clearCookies()
    await page.goto(`${ORIGIN}/login`)
    await page.fill('#user', USER)
    await page.fill('#password', ACCOUNTS.password)
    await Promise.all([page.waitForURL(/\/apps\//, { timeout: 60_000 }), page.press('#password', 'Enter')])
    await sleep(1500)
  },
  tasks: {
    // ----- Files (Drive) -----
    open_file: async ({ rng, sh }) => {
      const r = R(rng)
      const e = r.pick(entries(sh, `mimetype <> ${DIR_MIME} and name ~ '\\.(md|txt|pdf|jpg|png)$' and path ~ '^files/[^/]+/'`).filter((x) => !hidden(x) && !x.path.startsWith('Shared with Asha')))
      const fromRoot = r.chance(0.5)
      const steps = [...(fromRoot ? walk(e.parent) : []), { plan: fromRoot ? 2 : 1, do: 'click', target: { role: 'button', name: `View: ${e.name}` } }]
      const plan = fromRoot ? [{ title: `Open the folder ${e.parent}`, check: `url contains dir=` }, { title: `Open ${e.name}`, check: `the file ${e.name} is shown` }] : [{ title: `Open ${e.name}`, check: `the file ${e.name} is shown` }]
      return {
        goal: fileGoal(r, e.name, e.parent), start: fromRoot ? '/apps/files/files' : dirUrl(e.parent), plan, steps, writes: false, startWait: 2500,
        answer: `Opened ${e.parent}/${e.name}.`,
        verify: async ({ sh, page }) => exists(sh, e.path) && /openfile=true|\/files\/\d+/.test(page.url())
      }
    },
    search_file: async ({ rng, sh }) => {
      const r = R(rng)
      const all = entries(sh, `mimetype <> ${DIR_MIME} and name ~ '\\.(md|txt|pdf|jpg|png)$'`).filter((x) => !hidden(x))
      const counts = {}
      for (const x of all) counts[x.name] = (counts[x.name] ?? 0) + 1
      const e = r.pick(all.filter((x) => counts[x.name] === 1 && x.parent))
      const term = e.name.replace(/\.[^.]+$/, '')
      return {
        goal: r.pick([`Search my files for "${term}" and open it.`, `Find the file ${e.name} and open it.`, `Where is ${term}? Open it.`]),
        start: '/apps/files/files', startWait: 2500, writes: false,
        plan: [{ title: `Search for ${term}`, check: `text "${e.name}"` }, { title: `Open ${e.name}`, check: `the file ${e.name} is shown` }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'searchbox', name: 'Search here' }, text: term, settle: 2500 },
          { plan: 2, do: 'click', target: { role: 'button', name: `View: ${e.name}` } }
        ],
        answer: `${e.name} is in ${e.parent}.`,
        verify: async ({ sh, page }) => exists(sh, e.path) && /openfile=true|\/files\/\d+/.test(page.url())
      }
    },
    create_folder: async ({ rng, sh }) => {
      const r = R(rng)
      const parents = ['', ...entries(sh, `mimetype = ${DIR_MIME} and path ~ '^files/[^/]+$'`).filter((x) => !hidden(x) && x.name !== 'Shared with Asha').map((x) => x.path)]
      const parent = r.pick(parents)
      const name = r.pick(NEW_FOLDERS)
      const path = parent ? `${parent}/${name}` : name
      if (exists(sh, path)) return null
      return {
        goal: r.pick([`Create a folder called "${name}"${parent ? ` inside ${parent}` : ''}.`, `Make a new folder ${name}${parent ? ` in ${parent}` : ' in my files'}.`, `Add a folder named ${name}${parent ? ` under ${parent}` : ''}.`]),
        start: parent ? dirUrl(parent) : '/apps/files/files', startWait: 2500,
        plan: [{ title: 'Open the New menu', check: 'menuitem "New folder"' }, { title: 'Choose New folder', check: 'textbox "Folder name"' }, { title: `Name it ${name} and create it`, check: `text "${name}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'New' } },
          { plan: 2, do: 'click', target: { role: 'menuitem', name: 'New folder' } },
          { plan: 3, do: 'type', target: { role: 'textbox', name: 'Folder name' }, text: name },
          { plan: 3, do: 'click', target: { role: 'button', name: 'Create' }, settle: 2000 }
        ],
        answer: `Created the folder ${path}.`,
        verify: async ({ sh }) => one(sh, `select count(*) from oc_filecache where storage = ${HOME} and path = ${lit('files/' + path)} and mimetype = ${DIR_MIME}`) === '1'
      }
    },
    rename_file: async ({ rng, sh }) => {
      const r = R(rng)
      const e = r.pick(entries(sh, `mimetype <> ${DIR_MIME} and path ~ '^files/[^/]+/'`).filter((x) => !hidden(x) && !x.path.startsWith('Shared with Asha')))
      const ext = e.name.includes('.') ? e.name.slice(e.name.lastIndexOf('.')) : ''
      const base = e.name.slice(0, e.name.length - ext.length)
      const newBase = r.pick([`${base} (final)`, `${base} v2`, `${base} old`, `Copy of ${base}`, `${base} 2026`, `${base} - reviewed`])
      const newName = newBase + ext
      return {
        goal: r.pick([`Rename "${e.name}" in ${e.parent} to "${newName}".`, `Change the name of ${e.name} to ${newName}.`, `In ${e.parent}, rename ${e.name} as ${newName}.`]),
        start: dirUrl(e.parent), startWait: 2500,
        plan: [{ title: `Open the actions of ${e.name}`, check: 'menuitem "Rename"' }, { title: 'Choose Rename', check: 'textbox "Filename"' }, { title: `Type ${newName} and confirm`, check: `text "${newBase}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'Actions', ...rowOf(e.name) } },
          { plan: 2, do: 'click', target: { role: 'menuitem', name: 'Rename' } },
          { plan: 3, do: 'type', target: { role: 'textbox', name: 'Filename' }, text: newName },
          { plan: 3, do: 'press', key: 'Enter', settle: 2000 }
        ],
        answer: `Renamed ${e.name} to ${newName}.`,
        verify: async ({ sh }) => exists(sh, `${e.parent}/${newName}`) && !exists(sh, e.path)
      }
    },
    move_file: async ({ rng, sh }) => {
      const r = R(rng)
      const all = entries(sh).filter((x) => !hidden(x) && !x.path.startsWith('Shared with Asha') && x.path.split('/').length <= 2)
      const combos = []
      for (const f of all.filter((x) => !x.dir)) for (const d of all.filter((x) => x.dir && x.parent === f.parent)) combos.push([f, d])
      const [f, d] = r.pick(combos)
      const where = f.parent || 'All files'
      return {
        goal: r.pick([`Move "${f.name}" into the ${d.name} folder.`, `Put ${f.name} in ${d.path}.`, `Move the file ${f.name} from ${where} to ${d.name}.`]),
        start: f.parent ? dirUrl(f.parent) : '/apps/files/files', startWait: 2500,
        plan: [{ title: `Open the actions of ${f.name}`, check: 'menuitem "Move or copy"' }, { title: 'Choose Move or copy', check: 'heading "Choose destination"' }, { title: `Open ${d.name} in the picker`, check: `button "Move to ${d.name}"` }, { title: `Move to ${d.name}`, check: `text "${f.name}" is gone from ${where}` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'Actions', ...rowOf(f.name) } },
          { plan: 2, do: 'click', target: { role: 'menuitem', name: 'Move or copy' }, settle: 2000 },
          { plan: 3, do: 'click', target: { role: 'cell', name: d.name, under: /^dialog/ }, settle: 2000 },
          { plan: 4, do: 'click', target: { role: 'button', name: `Move to ${d.name}` }, settle: 2500 }
        ],
        answer: `Moved ${f.name} to ${d.path}.`,
        verify: async ({ sh }) => exists(sh, `${d.path}/${f.name}`) && !exists(sh, f.path)
      }
    },
    new_document: async ({ rng, sh }) => {
      const r = R(rng)
      const parent = r.pick(['', 'Projects', 'Documents', 'HR', 'Marketing', 'Finance', 'Projects/Atlas launch', 'Projects/Customer offsite'])
      const [title, body] = r.pick(NEW_DOCS)
      const name = `${title}.md`
      const path = parent ? `${parent}/${name}` : name
      if (exists(sh, path)) return null
      return {
        goal: r.pick([`Create a new text document "${title}"${parent ? ` in ${parent}` : ''} that says: ${body}`, `In ${parent || 'my files'}, make a document called ${title} with the text "${body}"`, `Write a new doc named ${title}${parent ? ` in ${parent}` : ''}: ${body}`]),
        start: parent ? dirUrl(parent) : '/apps/files/files', startWait: 2500,
        plan: [{ title: 'Open the New menu', check: 'menuitem "Text document"' }, { title: 'Choose Text document', check: 'textbox "Filename"' }, { title: `Name it ${name} and create it`, check: `heading "${name}"` }, { title: 'Type the text and save', check: `text "${body.slice(0, 30)}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'New' } },
          { plan: 2, do: 'click', target: { role: 'menuitem', name: 'Text document' } },
          { plan: 3, do: 'type', target: { role: 'textbox', name: 'Filename' }, text: name },
          { plan: 3, do: 'click', target: { role: 'button', name: 'Create' }, settle: 4000 },
          { plan: 4, do: 'type', target: { role: 'textbox', name: '', under: /^dialog/ }, text: body, settle: 1500 },
          { plan: 4, do: 'click', target: { role: 'button', name: 'Save document' }, settle: 2500, mayNotChange: true }
        ],
        answer: `Created ${path}.`,
        verify: async () => { try { return readFileSync(`${DATA}/${USER}/files/${path}`, 'utf8').includes(body.slice(0, 20)) } catch { return false } }
      }
    },
    favorite_file: async ({ rng, sh }) => {
      const r = R(rng)
      const favs = new Set(q(sh, `select m.objid from oc_vcategory_to_object m join oc_vcategory c on c.id = m.categoryid where c.uid = '${USER}' and c.category = '_$!<Favorite>!$_'`).map((x) => x[0]))
      const e = r.pick(entries(sh, `path ~ '^files/[^/]+(/[^/]+)?$'`).filter((x) => !hidden(x) && !x.path.startsWith('Shared with Asha') && !favs.has(x.fileid)))
      return {
        goal: r.pick([`Add ${e.name} to my favorites.`, `Star the ${e.dir ? 'folder' : 'file'} "${e.name}"${e.parent ? ` in ${e.parent}` : ''}.`, `Mark ${e.name} as a favorite.`]),
        start: e.parent ? dirUrl(e.parent) : '/apps/files/files', startWait: 2500,
        plan: [{ title: `Open the actions of ${e.name}`, check: 'menuitem "Add to favorites"' }, { title: 'Choose Add to favorites', check: `${e.name} shows a star` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'Actions', ...rowOf(e.name) } },
          { plan: 2, do: 'click', target: { role: 'menuitem', name: 'Add to favorites' }, settle: 2000 }
        ],
        answer: `${e.name} is now a favorite.`,
        verify: async ({ sh }) => one(sh, `select count(*) from oc_vcategory_to_object m join oc_vcategory c on c.id = m.categoryid where c.uid = '${USER}' and c.category = '_$!<Favorite>!$_' and m.objid = ${e.fileid}`) === '1'
      }
    },
    // ----- Calendar -----
    create_event: async ({ rng }) => {
      const r = R(rng)
      const title = r.pick(NEW_EVENTS)
      const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) + r.int(1, 30) * 86_400_000)
      const hour = r.int(9, 18); const min = r.pick([0, 0, 30])
      const d = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, min))
      const epoch = (d.getTime() - IST_MS) / 1000
      const dateText = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${d.getUTCFullYear()}`
      const timeText = hm(d)
      const when = `${longDate(d)} at ${timeText}`
      return {
        goal: r.pick([`Create a calendar event "${title}" on ${d.getUTCDate()} ${LONG_MONTHS[d.getUTCMonth()]} at ${timeText}.`, `Add ${title} to my calendar for ${when}.`, `Schedule "${title}" on ${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${LONG_MONTHS[d.getUTCMonth()]}, ${timeText}.`]),
        start: `/apps/calendar/timeGridWeek/${isoDay(d)}`, startWait: 3000,
        plan: [{ title: 'Open a new event', check: 'textbox "Title"' }, { title: `Type the title ${title}`, check: `textbox "Title" = ${title}` }, { title: `Set the date to ${dateText}`, check: `textbox "Start date" = ${dateText}` }, { title: `Set the start time to ${timeText}`, check: `textbox "Start time" = ${timeText}` }, { title: 'Save the event', check: `text "${title}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'Create new event' }, settle: 2000 },
          { plan: 2, do: 'type', target: { role: 'textbox', name: 'Title' }, text: title },
          { plan: 3, do: 'type', target: { role: 'textbox', name: 'Start date' }, text: dateText },
          { plan: 3, do: 'press', key: 'Enter', mayNotChange: true },
          { plan: 4, do: 'type', target: { role: 'textbox', name: 'Start time' }, text: timeText },
          { plan: 4, do: 'press', key: 'Enter', mayNotChange: true },
          { plan: 5, do: 'click', target: { role: 'button', name: 'Save' }, settle: 2500 }
        ],
        answer: `Created "${title}" on ${when}.`,
        verify: async ({ sh }) => events(sh).some((x) => x.summary === title && x.first === epoch)
      }
    },
    event_time: async ({ rng, sh }) => {
      const r = R(rng)
      const counts = {}
      const evs = events(sh)
      for (const x of evs) counts[x.summary] = (counts[x.summary] ?? 0) + 1
      const e = r.pick(evs.filter((x) => !x.rrule && !x.allday && !x.summary.includes("'") && counts[x.summary] === 1 && x.first > 1786000000 && x.first < 1796000000))
      const s = ist(e.first); const t = ist(e.last)
      const when = `${longDate(s)}, ${hm(s)} to ${hm(t)}`
      return {
        goal: r.pick([`When is "${e.summary}"?`, `What time is my ${e.summary}?`, `Look up ${e.summary} in my calendar: which day and time is it?`]),
        start: `/apps/calendar/timeGridWeek/${isoDay(s)}`, startWait: 3000, writes: false,
        plan: [{ title: `Open the event ${e.summary}`, check: `the details of ${e.summary} are shown` }],
        steps: [{ plan: 1, do: 'click', target: { role: 'generic', name: new RegExp(`^${esc(e.summary)}, `) }, settle: 2000 }],
        answer: `${e.summary} is on ${when}.`,
        verify: async ({ sh }) => events(sh).some((x) => x.id === e.id && x.first === e.first)
      }
    },
    // ----- Contacts -----
    add_contact: async ({ rng, sh }) => {
      const r = R(rng)
      const [name, org] = r.pick(NEW_PEOPLE)
      if (cardOf(sh, name)) return null
      const tel = phone(r)
      const email = `${name.toLowerCase().replace(/\s+/g, '.')}@${org.toLowerCase().replace(/\s+/g, '')}.test`
      return {
        goal: r.pick([`Add a contact: ${name} from ${org}, phone ${tel}, email ${email}.`, `Save ${name} (${org}) to my contacts with phone ${tel} and email ${email}.`, `Create a new contact for ${name} at ${org}. Phone: ${tel}. Email: ${email}.`]),
        start: '/apps/contacts/', startWait: 3000,
        plan: [{ title: 'Start a new contact', check: 'textbox "Name"' }, { title: 'Fill in name, company, phone and email', check: `textbox "Name" = ${name}` }, { title: 'Save the contact', check: `heading "${name}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'New contact' }, settle: 2000 },
          { plan: 2, do: 'type', target: { role: 'textbox', name: 'Name' }, text: name },
          { plan: 2, do: 'type', target: { role: 'textbox', name: 'Company' }, text: org },
          { plan: 2, do: 'type', target: { role: 'textbox', name: 'tel' }, text: tel },
          { plan: 2, do: 'type', target: { role: 'textbox', name: 'Email' }, text: email },
          { plan: 3, do: 'click', target: { role: 'button', name: 'Save' }, settle: 2500 }
        ],
        answer: `Added ${name} to contacts.`,
        verify: async ({ sh }) => { const c = cardOf(sh, name); return c.includes(org) && c.replace(/\s/g, '').includes(tel.replace(/\s/g, '')) && c.includes(email) }
      }
    },
    edit_contact_phone: async ({ rng, sh }) => {
      const r = R(rng)
      const c = r.pick(contacts(sh).filter((x) => x.tels === 1))
      const tel = phone(r)
      return {
        goal: r.pick([`Change ${c.fn}'s phone number to ${tel}.`, `Update the phone of ${c.fn} (${c.org}) to ${tel}.`, `${c.fn} has a new number: ${tel}. Update the contact.`]),
        start: '/apps/contacts/', startWait: 3000,
        plan: [{ title: `Search for ${c.fn}`, check: `text "${c.fn}"` }, { title: `Open ${c.fn}`, check: `heading "${c.fn}"` }, { title: 'Edit the contact', check: 'textbox "tel"' }, { title: `Set the phone to ${tel} and save`, check: `text "${tel}"` }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Search contacts …' }, text: c.fn, settle: 2000 },
          { plan: 2, do: 'click', target: { role: 'link', name: new RegExp(`^Select ${esc(c.fn)} `) }, settle: 2000 },
          { plan: 3, do: 'click', target: { role: 'button', name: 'Edit' } },
          { plan: 4, do: 'type', target: { role: 'textbox', name: 'tel' }, text: tel },
          { plan: 4, do: 'click', target: { role: 'button', name: 'Save' }, settle: 2500 }
        ],
        answer: `${c.fn}'s phone is now ${tel}.`,
        verify: async ({ sh }) => { const d = cardOf(sh, c.fn).replace(/\s/g, ''); return d.includes(tel.replace(/\s/g, '')) && !d.includes(c.tel.replace(/\s/g, '')) }
      }
    },
    contact_info: async ({ rng, sh }) => {
      const r = R(rng)
      const c = r.pick(contacts(sh))
      const [what, value] = r.pick([['email address', c.email], ['phone number', c.tel], ['company', c.org], ['job title', c.title]].filter((x) => x[1]))
      return {
        goal: r.pick([`What is ${c.fn}'s ${what}?`, `Find ${c.fn} in my contacts and tell me the ${what}.`, `Look up the ${what} of ${c.fn}.`]),
        start: '/apps/contacts/', startWait: 3000, writes: false,
        plan: [{ title: `Search for ${c.fn}`, check: `text "${c.fn}"` }, { title: `Open ${c.fn}`, check: `heading "${c.fn}"` }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Search contacts …' }, text: c.fn, settle: 2000 },
          { plan: 2, do: 'click', target: { role: 'link', name: new RegExp(`^Select ${esc(c.fn)} `) }, settle: 2000 }
        ],
        answer: `${c.fn}'s ${what} is ${value}.`,
        verify: async ({ sh }) => cardOf(sh, c.fn).includes(value)
      }
    },
    // ----- Deck (Trello-like) -----
    add_card: async ({ rng, sh }) => {
      const r = R(rng)
      const b = r.pick(boards(sh))
      const s = r.pick(stacksOf(sh, b.id))
      const title = r.pick(NEW_CARDS)
      if (deckCards(sh, `c.title = ${lit(title)}`).length) return null
      return {
        goal: r.pick([`Add a card "${title}" to the ${s.title} list on the ${b.title} board.`, `On ${b.title}, create a card ${title} in ${s.title}.`, `New card in ${b.title} / ${s.title}: ${title}.`]),
        start: `/apps/deck/board/${b.id}`, startWait: 3000,
        plan: [{ title: `Click Add card in ${s.title}`, check: 'textbox "Add a new card"' }, { title: `Type ${title} and press Enter`, check: `heading "${title}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'Add card', under: new RegExp(`^generic ${esc(s.title)}$`) } },
          { plan: 2, do: 'type', target: { role: 'textbox', name: 'Add a new card' }, text: title },
          { plan: 2, do: 'press', key: 'Enter', settle: 2000 }
        ],
        answer: `Added "${title}" to ${s.title} on ${b.title}.`,
        verify: async ({ sh }) => deckCards(sh, `c.title = ${lit(title)} and s.id = ${s.id}`).length === 1
      }
    },
    move_card: async ({ rng, sh }) => {
      const r = R(rng)
      const c = r.pick(deckCards(sh))
      const to = r.pick(stacksOf(sh, c.boardId).filter((s) => s.id !== c.stackId))
      return {
        goal: r.pick([`Move the card "${c.title}" to ${to.title}.`, `On the ${c.board} board, move ${c.title} from ${c.stack} to ${to.title}.`, `${c.title} should be in ${to.title} now. Move it.`]),
        start: `/apps/deck/board/${c.boardId}`, startWait: 3000,
        plan: [{ title: `Open the actions of ${c.title}`, check: 'button "Move/copy card"' }, { title: 'Choose Move/copy card', check: 'heading "Move/copy card"' }, { title: `Keep the board ${c.board}`, check: 'combobox "Select a list"' }, { title: `Choose the list ${to.title}`, check: `option "${to.title}" is chosen` }, { title: 'Click Move card', check: `${c.title} is in ${to.title}` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'Actions', inside: new RegExp(`^${esc(c.title)}`), insideDepth: 3 } },
          { plan: 2, do: 'click', target: { role: 'button', name: 'Move/copy card' }, settle: 1500 },
          { plan: 3, do: 'click', target: { role: 'option', name: loose(c.board) } },
          { plan: 4, do: 'click', target: { role: 'combobox', name: 'Select a list' } },
          { plan: 4, do: 'click', target: { role: 'option', name: loose(to.title) } },
          { plan: 5, do: 'click', target: { role: 'button', name: 'Move card' }, settle: 2000 }
        ],
        answer: `Moved ${c.title} to ${to.title}.`,
        verify: async ({ sh }) => deckCards(sh, `c.id = ${c.id} and s.id = ${to.id}`).length === 1
      }
    },
    comment_card: async ({ rng, sh }) => {
      const r = R(rng)
      const c = r.pick(deckCards(sh))
      const text = r.pick(COMMENTS)
      return {
        goal: r.pick([`Comment "${text}" on the card ${c.title}.`, `On ${c.board}, add a comment to "${c.title}": ${text}`, `Reply on card ${c.title} with: ${text}`]),
        start: `/apps/deck/board/${c.boardId}`, startWait: 3000,
        plan: [{ title: `Open the card ${c.title}`, check: `heading "${c.title}"` }, { title: 'Open the Comments tab', check: 'tab "Comments"' }, { title: 'Type the comment and send it', check: `text "${text}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'heading', name: c.title }, settle: 2000 },
          { plan: 2, do: 'click', target: { role: 'tab', name: 'Comments' } },
          { plan: 3, do: 'type', target: { role: 'textbox', under: /^tabpanel Comments/ }, text },
          { plan: 3, do: 'press', key: 'Enter', settle: 2000 }
        ],
        answer: `Commented on ${c.title}.`,
        verify: async ({ sh }) => one(sh, `select count(*) from oc_comments where object_type = 'deckCard' and object_id = '${c.id}' and message = ${lit(text)}`) === '1'
      }
    },
    set_due_date: async ({ rng, sh }) => {
      const r = R(rng)
      const c = r.pick(deckCards(sh))
      const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) + r.int(3, 40) * 86_400_000)
      const hour = r.pick([10, 12, 15, 17, 18])
      const local = `${isoDay(day)}T${String(hour).padStart(2, '0')}:00`
      const utc = new Date(Date.parse(`${local}:00Z`) - IST_MS).toISOString().slice(0, 16).replace('T', ' ')
      const d = new Date(Date.parse(`${local}:00Z`))
      return {
        goal: r.pick([`Set the due date of "${c.title}" to ${d.getUTCDate()} ${LONG_MONTHS[d.getUTCMonth()]}, ${hm(d)}.`, `${c.title} is due on ${longDate(d)} at ${hm(d)}. Set it on the card.`, `Give the card ${c.title} a due date of ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${hm(d)}.`]),
        start: `/apps/deck/board/${c.boardId}`, startWait: 3000,
        plan: [{ title: `Open the card ${c.title}`, check: `heading "${c.title}"` }, { title: `Set the due date to ${local.replace('T', ' ')}`, check: `textbox "Please choose a date" = ${local}` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'heading', name: c.title }, settle: 2000 },
          { plan: 2, do: 'click', target: { role: 'button', name: 'Add due date' }, optional: true },
          { plan: 2, do: 'click', target: { role: 'menuitem', name: 'Choose a date' }, optional: true },
          { plan: 2, do: 'type', target: { role: 'textbox', name: 'Please choose a date' }, text: local, mayNotChange: true },
          { plan: 2, do: 'press', key: 'Tab', settle: 2000, mayNotChange: true }
        ],
        answer: `${c.title} is now due ${longDate(d)} at ${hm(d)}.`,
        verify: async ({ sh }) => deckCards(sh, `c.id = ${c.id}`)[0]?.due === utc
      }
    },
    card_due: async ({ rng, sh }) => {
      const r = R(rng)
      const c = r.pick(deckCards(sh, 'c.duedate is not null'))
      const d = new Date(Date.parse(c.due.replace(' ', 'T') + ':00Z') + IST_MS)
      return {
        goal: r.pick([`When is the card "${c.title}" due?`, `What is the due date of ${c.title} on the ${c.board} board?`, `Check the deadline for ${c.title}.`]),
        start: `/apps/deck/board/${c.boardId}`, startWait: 3000, writes: false,
        plan: [{ title: `Open the card ${c.title}`, check: `heading "${c.title}"` }],
        steps: [{ plan: 1, do: 'click', target: { role: 'heading', name: c.title }, settle: 2000 }],
        answer: `${c.title} is due ${longDate(d)} at ${hm(d)}.`,
        verify: async ({ sh }) => deckCards(sh, `c.id = ${c.id}`)[0]?.due === c.due
      }
    }
  }
}
