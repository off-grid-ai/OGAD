// Planka v2 on tasks.farm.test: a Trello-like board app (node on 127.0.0.1:7153 + postgres DB "planka").
// Seed: seed/tasks_seed.mjs (25 users, 3 projects, 6 boards, 432 cards, labels, members, due dates, checklists, comments).
// The user is asha.rao (editor on every board). Reset: farm/tasks/reset.sh (DB from template planka_seed, <1 s).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
const ORIGIN = 'http://tasks.farm.test'
const USER = 'asha.rao'
const LISTS = ['Backlog', 'To Do', 'In Progress', 'Review', 'Done']
const LABELS = ['Bug', 'Feature', 'Urgent', 'Design', 'Backend', 'Research', 'Blocked', 'Quick win']

const sql = (sh, q) => sh('PGPASSWORD=planka psql -h 127.0.0.1 -U planka planka -tA -F "$(printf \'\\t\')"', { input: q, stdio: ['pipe', 'pipe', 'pipe'] })
  .trim().split('\n').filter(Boolean).map((l) => l.split('\t'))
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Cards on active lists with board/list names, labels, members, due date (IST), task-list count. */
function cards(sh, where = 'TRUE') {
  return sql(sh, `SELECT c.id, c.name, b.id, b.name, l.name, COALESCE(to_char(c.due_date + interval '5 hours 30 minutes', 'MM/DD/YYYY'), ''),
      COALESCE(to_char(c.due_date + interval '5 hours 30 minutes', 'FMMonth FMDD, YYYY'), ''),
      COALESCE((SELECT string_agg(lb.name, ',' ORDER BY lb.position) FROM card_label cl JOIN label lb ON lb.id=cl.label_id WHERE cl.card_id=c.id), ''),
      COALESCE((SELECT string_agg(u.name, ',' ORDER BY u.name) FROM card_membership cm JOIN user_account u ON u.id=cm.user_id WHERE cm.card_id=c.id), ''),
      (SELECT count(*) FROM task_list t WHERE t.card_id=c.id), c.comments_total
    FROM card c JOIN list l ON l.id=c.list_id JOIN board b ON b.id=c.board_id WHERE l.type='active' AND ${where}`)
    .map(([id, name, boardId, board, list, due, dueLong, labels, members, taskLists, comments]) => ({ id, name, boardId, board, list, due, dueLong, labels: labels ? labels.split(',') : [], members: members ? members.split(',') : [], taskLists: Number(taskLists), comments: Number(comments) }))
}
/** A card whose name is not a prefix of another card name on the same board (so the card button is unambiguous). */
function pickCard(rng, sh, filter = () => true) {
  const all = cards(sh)
  const ok = all.filter((c) => filter(c) && !all.some((o) => o.id !== c.id && o.boardId === c.boardId && (o.name === c.name || o.name.startsWith(`${c.name} `))))
  return ok.length ? rng.pick(ok) : null
}
// The card's role=button wrapper is the drag handle; the click that opens a card lands on its title text.
const cardButton = (c) => ({ role: 'generic', value: c.name, inside: new RegExp(`^${esc(c.name)}( |$)`), insideRole: 'button', insideDepth: 4 })
/** Open a card: from its board (click the card) or straight from its URL. */
function openCard(rng, c, plan = 1) {
  if (rng.chance(0.5)) return { start: `/cards/${c.id}`, steps: [], plan: [] }
  return {
    start: `/boards/${c.boardId}`,
    steps: [{ plan, do: 'click', target: cardButton(c), settle: 1800 }],
    plan: [{ title: `Open the card "${c.name}"`, check: `textbox = ${c.name}` }]
  }
}
const withOpen = (o, plan, steps) => ({ start: o.start, plan: [...o.plan, ...plan], steps: [...o.steps, ...steps.map((s) => ({ ...s, plan: s.plan + o.plan.length }))] })
const fmtDate = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`
const longDate = (d) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

const tasks = {
  create_card: async ({ rng, sh }) => {
    const boards = sql(sh, 'SELECT id, name FROM board ORDER BY position')
    const [boardId, board] = rng.pick(boards)
    const list = rng.pick(LISTS.slice(0, 4))
    const title = `${rng.pick(['Follow up with', 'Prepare deck for', 'Review notes from', 'Fix issue reported by', 'Schedule call with', 'Draft email to', 'Update budget for', 'Plan workshop with'])} ${rng.pick(['Northwind', 'Acme', 'the design team', 'finance', 'Meera', 'Kabir', 'the Pune office', 'legal', 'the vendor', 'support'])} ${rng.int(2, 99)}`
    return {
      goal: rng.pick([`Add a card "${title}" to the ${list} list on the ${board} board.`, `On ${board}, create a new card in ${list} called "${title}".`, `Create a task "${title}" under ${list}.`]),
      start: `/boards/${boardId}`,
      plan: [
        { title: `Open the new-card form in ${list}`, check: 'textbox "Enter card title..."' },
        { title: `Type "${title}" and add the card`, check: `text "${title}"` }
      ],
      steps: [
        { plan: 1, do: 'click', target: { role: 'button', name: 'Add another card', inside: new RegExp(`^${esc(list)} `), insideDepth: 2 } },
        { plan: 2, do: 'type', target: { role: 'textbox', name: 'Enter card title...' }, text: title },
        { plan: 2, do: 'click', target: { role: 'button', name: 'Add card' }, settle: 1800 }
      ],
      answer: `Created "${title}" in ${list}.`,
      verify: async () => sql(sh, `SELECT l.name FROM card c JOIN list l ON l.id=c.list_id WHERE c.board_id=${boardId} AND c.name=${lit(title)}`)[0]?.[0] === list
    }
  },

  move_card: async ({ rng, sh }) => {
    const c = pickCard(rng, sh)
    const to = rng.pick(LISTS.filter((l) => l !== c.list))
    const o = openCard(rng, c)
    return {
      goal: rng.pick([`Move the card "${c.name}" to ${to}.`, `"${c.name}" should be in ${to} now; move it.`, `On ${c.board}, move "${c.name}" from ${c.list} to ${to}.`]),
      ...withOpen(o, [
        { title: 'Open the list picker', check: 'textbox "Search lists..."' },
        { title: `Choose ${to}`, check: `button "${to}"` }
      ], [
        { plan: 1, do: 'click', target: { role: 'button', name: c.list, inside: /^List / , insideDepth: 2 } },
        { plan: 2, do: 'click', target: { role: 'generic', value: to, inside: /Search lists/, insideDepth: 3 }, settle: 1800 }
      ]),
      answer: `Moved "${c.name}" to ${to}.`,
      verify: async () => sql(sh, `SELECT l.name FROM card c JOIN list l ON l.id=c.list_id WHERE c.id=${c.id}`)[0]?.[0] === to
    }
  },

  add_label: async ({ rng, sh }) => {
    const c = pickCard(rng, sh, (x) => x.labels.length < 4)
    const label = rng.pick(LABELS.filter((l) => !c.labels.includes(l)))
    const o = openCard(rng, c)
    return {
      goal: rng.pick([`Add the ${label} label to "${c.name}".`, `Label the card "${c.name}" as ${label}.`, `Tag "${c.name}" with ${label}.`]),
      ...withOpen(o, [
        { title: 'Open Labels', check: 'textbox "Search labels..."' },
        { title: `Pick ${label}`, check: `button "${label}" on the card` }
      ], [
        { plan: 1, do: 'click', target: { role: 'button', name: 'Labels', inside: /^Add to card/, insideDepth: 2 } },
        { plan: 2, do: 'click', target: { role: 'button', name: new RegExp(`^(\\W+ )?${esc(label)}$`), inside: /Search labels/, insideDepth: 4 }, settle: 1500 }
      ]),
      answer: `"${c.name}" now has the ${label} label.`,
      verify: async () => sql(sh, `SELECT 1 FROM card_label cl JOIN label l ON l.id=cl.label_id WHERE cl.card_id=${c.id} AND l.name=${lit(label)}`).length === 1
    }
  },

  set_due_date: async ({ rng, sh }) => {
    const c = pickCard(rng, sh)
    const d = new Date(Date.UTC(2026, 9, 16) + rng.int(2, 75) * 86400000)
    const date = fmtDate(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    const nice = longDate(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
    if (date === c.due) return null
    const o = openCard(rng, c)
    return {
      goal: rng.pick([`Set the due date of "${c.name}" to ${nice}.`, `"${c.name}" is due on ${nice}. Update the card.`, `Change the deadline of "${c.name}" to ${date}.`]),
      ...withOpen(o, [
        { title: 'Open the due date editor', check: 'text "Edit Due Date"' },
        { title: `Enter ${date}`, check: `textbox = ${date}` },
        { title: 'Save the date', check: `the card shows the due date` }
      ], [
        { plan: 1, do: 'click', target: { role: 'button', name: 'Due Date', inside: /^Add to card/, insideDepth: 2 } },
        { plan: 2, do: 'type', target: { role: 'textbox', inside: /^Date\b/, insideDepth: 1 }, text: date },
        { plan: 3, do: 'click', target: { role: 'button', name: 'Save' }, settle: 1500 }
      ]),
      answer: `"${c.name}" is now due ${nice}.`,
      verify: async () => sql(sh, `SELECT to_char(due_date + interval '5 hours 30 minutes', 'MM/DD/YYYY') FROM card WHERE id=${c.id}`)[0]?.[0] === date
    }
  },

  add_checklist_item: async ({ rng, sh }) => {
    const c = pickCard(rng, sh, (x) => x.taskLists === 1)
    const item = `${rng.pick(['Call', 'Email', 'Check with', 'Confirm with', 'Send notes to', 'Ask'])} ${rng.pick(['Rohan', 'Meera', 'Kabir', 'Priya', 'the vendor', 'finance', 'legal', 'Arjun'])} ${rng.pick(['about the budget', 'about timelines', 'for sign-off', 'on the draft', 'about access', 'before Friday'])}`
    const o = openCard(rng, c)
    return {
      goal: rng.pick([`Add "${item}" to the checklist of "${c.name}".`, `On the card "${c.name}", add a checklist item: ${item}.`, `Add a task "${item}" to ${c.name}.`]),
      ...withOpen(o, [
        { title: 'Open the new task field', check: 'textbox "Enter task description..."' },
        { title: `Type the task and add it`, check: `text "${item}"` }
      ], [
        { plan: 1, do: 'click', target: { role: 'button', name: 'Add another task' } },
        { plan: 2, do: 'type', target: { role: 'textbox', name: 'Enter task description...' }, text: item },
        { plan: 2, do: 'click', target: { role: 'button', name: 'Add task' }, settle: 1500 }
      ]),
      answer: `Added "${item}" to the checklist of "${c.name}".`,
      verify: async () => sql(sh, `SELECT 1 FROM task t JOIN task_list tl ON tl.id=t.task_list_id WHERE tl.card_id=${c.id} AND t.name=${lit(item)}`).length === 1
    }
  },

  // complete_task is left out: Planka's task checkbox is a hidden <input> (the visible box is an unlabelled <label>), so it cannot be clicked by role.

  comment: async ({ rng, sh }) => {
    const c = pickCard(rng, sh)
    const text = `${rng.pick(['Update:', 'FYI:', 'Note:', 'Quick update -'])} ${rng.pick(['this is on track', 'waiting for the vendor reply', 'moved the review to Monday', 'draft shared with the team', 'need one more day', 'tested on staging, looks good'])} (${rng.int(10, 99)})`
    const o = openCard(rng, c)
    return {
      goal: rng.pick([`Comment on "${c.name}": ${text}`, `Add a comment to the card "${c.name}" saying "${text}".`, `Reply on ${c.name} with: ${text}`]),
      ...withOpen(o, [
        { title: 'Write the comment', check: `textbox "Write a comment..." = ${text}` },
        { title: 'Post it', check: `text "${text}"` }
      ], [
        { plan: 1, do: 'type', target: { role: 'textbox', name: 'Write a comment...' }, text },
        { plan: 2, do: 'click', target: { role: 'button', name: 'Add comment' }, settle: 1500 }
      ]),
      answer: `Commented on "${c.name}".`,
      verify: async () => sql(sh, `SELECT 1 FROM comment m JOIN user_account u ON u.id=m.user_id WHERE m.card_id=${c.id} AND u.username='${USER}' AND m.text=${lit(text)}`).length === 1
    }
  },

  archive_card: async ({ rng, sh }) => {
    const c = pickCard(rng, sh, (x) => x.list === 'Done' || rng.chance(0.3))
    const o = openCard(rng, c)
    return {
      goal: rng.pick([`Archive the card "${c.name}".`, `"${c.name}" is finished; archive it.`, `Remove "${c.name}" from the board by archiving it.`]),
      ...withOpen(o, [
        { title: 'Click Archive', check: 'text "Are you sure you want to archive this card?"' },
        { title: 'Confirm', check: `the card "${c.name}" is gone from the board` }
      ], [
        { plan: 1, do: 'click', target: { role: 'button', name: 'Archive', inside: /^Actions/, insideDepth: 2 } },
        { plan: 2, do: 'click', target: { role: 'button', name: 'Archive card' }, settle: 1800 }
      ]),
      answer: `Archived "${c.name}".`,
      verify: async () => sql(sh, `SELECT l.type FROM card c JOIN list l ON l.id=c.list_id WHERE c.id=${c.id}`)[0]?.[0] === 'archive'
    }
  },

  add_member: async ({ rng, sh }) => {
    const c = pickCard(rng, sh, (x) => x.members.length < 3)
    const pool = sql(sh, `SELECT u.name FROM board_membership bm JOIN user_account u ON u.id=bm.user_id JOIN card c ON c.board_id=bm.board_id WHERE c.id=${c.id}`).map((r) => r[0]).filter((n) => !c.members.includes(n))
    if (!pool.length) return null
    const who = rng.pick(pool)
    const o = openCard(rng, c)
    return {
      goal: rng.pick([`Assign ${who} to the card "${c.name}".`, `Add ${who} as a member of "${c.name}".`, `Put ${who.split(' ')[0]} on "${c.name}".`]),
      ...withOpen(o, [
        { title: 'Open Members', check: 'textbox "Search members..."' },
        { title: `Pick ${who}`, check: `${who} is a member of the card` }
      ], [
        { plan: 1, do: 'click', target: { role: 'button', name: 'Members', inside: /^Add to card/, insideDepth: 2 } },
        { plan: 2, do: 'click', target: { role: 'generic', value: new RegExp(`^(\\W+ )?${esc(who)}$`), inside: /Search members/, insideDepth: 4 }, settle: 1500 }
      ]),
      answer: `${who} is now on "${c.name}".`,
      verify: async () => sql(sh, `SELECT 1 FROM card_membership cm JOIN user_account u ON u.id=cm.user_id WHERE cm.card_id=${c.id} AND u.name=${lit(who)}`).length === 1
    }
  },

  // Read a fact from a card (due date, list, members, labels, checklist progress).
  read_card: async ({ rng, sh }) => {
    const c = pickCard(rng, sh, (x) => x.due || x.members.length || x.labels.length)
    const facts = []
    if (c.due) facts.push(['due', [`When is "${c.name}" due?`, `What is the due date of the card "${c.name}"?`], `"${c.name}" is due ${c.dueLong}.`])
    facts.push(['list', [`Which list is "${c.name}" in?`, `What is the status column of "${c.name}"?`], `"${c.name}" is in ${c.list}.`])
    if (c.members.length) facts.push(['members', [`Who is assigned to "${c.name}"?`, `Who are the members of the card "${c.name}"?`], `${c.members.join(' and ')}.`])
    if (c.labels.length) facts.push(['labels', [`What labels does "${c.name}" have?`], `${c.labels.join(', ')}.`])
    const [kind, goals, answer] = rng.pick(facts)
    const viaSearch = rng.chance(0.4)
    return {
      goal: rng.pick(goals) + (viaSearch ? '' : ` It is on the ${c.board} board.`),
      start: `/boards/${c.boardId}`,
      plan: [
        ...(viaSearch ? [{ title: `Search the board for ${c.name}`, check: `textbox "Search cards..." = ${c.name}` }] : []),
        { title: `Open the card "${c.name}"`, check: `textbox = ${c.name}` }
      ],
      steps: [
        ...(viaSearch ? [{ plan: 1, do: 'type', target: { role: 'textbox', name: 'Search cards...' }, text: c.name, settle: 1800 }] : []),
        { plan: viaSearch ? 2 : 1, do: 'click', target: cardButton(c), settle: 1800 }
      ],
      answer,
      verify: async ({ snapshot }) => snapshot.includes(c.name) && cards(sh, `c.id=${c.id}`)[0]?.[kind === 'members' ? 'members' : kind] !== undefined,
      writes: false
    }
  }
}

export default {
  name: 'planka',
  family: 'board',
  origin: ORIGIN,
  portOffset: 51,
  async reset({ sh }) { sh('bash /workspace/action-data-gen/scripts/clones/farm/tasks/reset.sh') },
  async login({ page, sleep }) {
    await page.context().clearCookies()
    await page.goto(`${ORIGIN}/login`)
    await page.evaluate(() => localStorage.clear()).catch(() => {})
    await page.goto(`${ORIGIN}/login`)
    await page.fill('input[name=emailOrUsername]', USER)
    await page.fill('input[name=password]', ACCOUNTS.password)
    await page.keyboard.press('Enter')
    await page.waitForURL((u) => !/login/.test(u.pathname), { timeout: 30_000 })
    await sleep(1500)
  },
  tasks
}
