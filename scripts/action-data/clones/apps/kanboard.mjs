// Kanboard on board.farm.test: Trello-like boards (sqlite in /dev/shm, file-copy reset). HELD-OUT TEST APP:
// its rows go only to /workspace/action-data/clones-test-kanboard/ and are never used for training.
// Persona meera.iyer: project manager in all six projects.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
export const ME = 'meera.iyer'
const ORIGIN = 'http://board.farm.test'
const DB = '/dev/shm/clone-farm/kanboard/db.sqlite'

function sql(sh, q) {
  const out = sh(`sqlite3 -separator '\t' ${DB} <<'SQL'\n.timeout 5000\n${q}\nSQL`)
  return out.split('\n').filter(Boolean).map((l) => l.split('\t'))
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`

/** An open task: { id, title, project, projectId, column, columnId, owner, due } with a title unique in its project. */
function pickTask(sh, rng, where = '1=1') {
  const rows = sql(sh, `select t.id, t.title, p.name, p.id, c.title, c.id, coalesce(u.name, ''), t.date_due from tasks t join projects p on p.id = t.project_id
    join columns c on c.id = t.column_id left join users u on u.id = t.owner_id
    where t.is_active = 1 and ${where} and (select count(*) from tasks t2 where t2.project_id = t.project_id and t2.title = t.title) = 1 order by random() limit 1`)
  if (!rows.length) return null
  const [id, title, project, projectId, column, columnId, owner, due] = rows[0]
  return { id, title, project, projectId, column, columnId, owner, due: Number(due) }
}
const taskPath = (t) => `/?controller=TaskViewController&action=show&task_id=${t.id}&project_id=${t.projectId}`
const boardPath = (pid) => `/?controller=BoardViewController&action=show&project_id=${pid}`
const fmtDate = (d) => `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()} 17:00`
const human = (d) => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

/** The modal's Save: the task page also has an inline comment form with its own Save above it. */
const SAVE = { role: 'button', name: 'Save', nth: 99, only: true }

const NEW_TASKS = ['Book the venue for the team offsite', 'Prepare the November status report', 'Call the vendor about the late invoice', 'Update the onboarding checklist',
  'Review the Q4 budget draft', 'Order laptops for new joiners', 'Plan the Diwali giveaway', 'Collect feedback from the beta users', 'Fix the broken link in the footer',
  'Draft the press release', 'Renew the domain name', 'Archive old tickets', 'Schedule the security audit', 'Translate the FAQ into Marathi', 'Clean up the shared drive']
const COMMENTS = ['I will pick this up tomorrow.', 'Waiting on the vendor reply.', 'Done, please review.', 'Moved the deadline after the call with finance.', 'Can someone from QA check this?',
  'Blocked until the permit arrives.', 'Added the notes to the shared folder.', 'This is now high priority.', 'Looks good to me, closing soon.']
const SUBTASKS = ['Get two quotes', 'Share the draft', 'Confirm with the client', 'Update the checklist', 'Book a meeting room', 'Send the reminder email', 'Check the budget']

export default {
  name: 'kanboard',
  family: 'board',
  origin: ORIGIN,
  portOffset: 22,
  explorePaths: ['/?controller=DashboardController&action=show', '/?controller=BoardViewController&action=show&project_id=1', '/?controller=ProjectListController&action=show'],
  async reset({ sh }) { sh('bash /workspace/action-data-gen/scripts/clones/farm/kanboard/reset.sh') },
  async login({ page, sleep }) {
    await page.context().clearCookies()
    await page.goto(`${ORIGIN}/?controller=AuthController&action=login`)
    await page.fill('#form-username', ME)
    await page.fill('#form-password', ACCOUNTS.password)
    await Promise.all([page.waitForURL((u) => !u.search.includes('AuthController'), { timeout: 30_000 }), page.keyboard.press('Enter')])
    await sleep(800)
  },
  tasks: {
    move_task: async ({ rng, sh }) => {
      const t = pickTask(sh, rng)
      if (!t) return null
      const cols = sql(sh, `select id, title from columns where project_id = ${t.projectId} and id <> ${t.columnId}`)
      const [colId, col] = rng.pick(cols)
      return {
        goal: rng.pick([`Move the task "${t.title}" to ${col}.`, `In ${t.project}, put "${t.title}" in the ${col} column.`, `"${t.title}" is now ${col}: move it there.`]),
        start: taskPath(t), answer: `Moved "${t.title}" to ${col}.`,
        plan: [{ title: 'Click Move position', check: 'the move form is shown' }, { title: `Choose the column ${col}`, check: `combobox = ${col}` }, { title: 'Click Save', check: `text "${col}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'link', name: 'Move position' }, settle: 1500 },
          { plan: 2, do: 'select', target: { role: 'combobox', name: /column/i }, value: col },
          { plan: 3, do: 'click', target: SAVE, settle: 1800 },
        ],
        verify: async ({ sh }) => sql(sh, `select column_id from tasks where id = ${t.id}`)[0][0] === colId,
      }
    },
    create_task: async ({ rng, sh }) => {
      const [pid, project] = rng.pick(sql(sh, 'select id, name from projects'))
      const title = rng.pick(NEW_TASKS)
      return {
        goal: rng.pick([`Add a task "${title}" to the ${project} board.`, `Create a new task in ${project}: ${title}.`, `On the ${project} project, create the card "${title}".`]),
        start: boardPath(pid), answer: `Created the task "${title}" in ${project}.`,
        plan: [{ title: 'Open the new task form', check: 'textbox "Title"' }, { title: 'Type the title', check: `textbox "Title" = ${title}` }, { title: 'Click Save', check: `text "${title}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'link', name: /^Add a new task/ }, settle: 1500 },
          { plan: 2, do: 'type', target: { role: 'textbox', name: 'Title' }, text: title },
          { plan: 3, do: 'click', target: SAVE, settle: 1800 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from tasks where project_id = ${pid} and title = ${lit(title)}`).length >= 1,
      }
    },
    set_due_date: async ({ rng, sh }) => {
      // Only tasks without a due date: the date picker restores an existing date when a typed value replaces it.
      const t = pickTask(sh, rng, 't.date_due = 0')
      if (!t) return null
      const d = new Date(Date.UTC(2026, rng.int(9, 11), rng.int(1, 28)))
      return {
        goal: rng.pick([`Set the due date of "${t.title}" to ${human(d)}.`, `"${t.title}" in ${t.project} has no deadline yet. Make it due on ${human(d)}.`, `Give "${t.title}" a due date of ${human(d)}.`]),
        start: taskPath(t), answer: `"${t.title}" is now due on ${human(d)}.`,
        plan: [{ title: 'Click Edit the task', check: 'the edit form is shown' }, { title: `Type ${fmtDate(d)} in Due Date`, check: `textbox "Due Date" = ${fmtDate(d)}` }, { title: 'Click Save', check: 'the task shows the new due date' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'link', name: 'Edit the task' }, settle: 1500 },
          { plan: 2, do: 'type', target: { role: 'textbox', name: /^Due Date/ }, text: fmtDate(d) },
          { plan: 3, do: 'click', target: SAVE, settle: 1800 },
        ],
        verify: async ({ sh }) => sql(sh, `select date(date_due, 'unixepoch') from tasks where id = ${t.id}`)[0][0] === d.toISOString().slice(0, 10),
      }
    },
    assign_task: async ({ rng, sh }) => {
      const t = pickTask(sh, rng)
      if (!t) return null
      const people = sql(sh, `select u.id, u.name from project_has_users pu join users u on u.id = pu.user_id where pu.project_id = ${t.projectId} and u.name <> ${lit(t.owner)}`)
      const [uid, name] = rng.pick(people)
      return {
        goal: rng.pick([`Assign "${t.title}" to ${name}.`, `Make ${name} the assignee of the task "${t.title}" in ${t.project}.`]),
        start: taskPath(t), answer: `"${t.title}" is assigned to ${name}.`,
        plan: [{ title: 'Click Edit the task', check: 'the edit form is shown' }, { title: `Choose ${name} as Assignee`, check: `combobox "Assignee" = ${name}` }, { title: 'Click Save', check: `text "${name}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'link', name: 'Edit the task' }, settle: 1500 },
          { plan: 2, do: 'select', target: { role: 'combobox', name: /^Assignee/ }, value: name },
          { plan: 3, do: 'click', target: SAVE, settle: 1800 },
        ],
        verify: async ({ sh }) => sql(sh, `select owner_id from tasks where id = ${t.id}`)[0][0] === uid,
      }
    },
    comment_task: async ({ rng, sh }) => {
      const t = pickTask(sh, rng)
      if (!t) return null
      const text = rng.pick(COMMENTS)
      return {
        goal: rng.pick([`Comment "${text}" on the task "${t.title}".`, `Add a comment to "${t.title}" in ${t.project}: ${text}`]),
        start: taskPath(t), answer: `Commented on "${t.title}".`,
        plan: [{ title: 'Click Add a comment', check: 'the comment form is shown' }, { title: 'Type the comment', check: `textbox "New comment" = ${text}` }, { title: 'Click Save', check: `text "${text}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'link', name: 'Add a comment' }, settle: 1500 },
          // The page may also show an inline comment form: the modal's box is the last one.
          { plan: 2, do: 'type', target: { role: 'textbox', name: 'New comment', nth: 99, only: true }, text },
          { plan: 3, do: 'click', target: SAVE, settle: 1800 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from comments c join users u on u.id = c.user_id where c.task_id = ${t.id} and c.comment = ${lit(text)} and u.username = ${lit(ME)}`).length === 1,
      }
    },
    add_subtask: async ({ rng, sh }) => {
      const t = pickTask(sh, rng)
      if (!t) return null
      const title = rng.pick(SUBTASKS)
      if (sql(sh, `select 1 from subtasks where task_id = ${t.id} and title = ${lit(title)}`).length) return null
      return {
        goal: rng.pick([`Add a sub-task "${title}" to "${t.title}".`, `Break "${t.title}" down: add the sub-task ${title}.`]),
        start: taskPath(t), answer: `Added the sub-task "${title}".`,
        plan: [{ title: 'Click Add a sub-task', check: 'the sub-task form is shown' }, { title: 'Type the sub-task title', check: `textbox "Title" = ${title}` }, { title: 'Click Save', check: `text "${title}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'link', name: 'Add a sub-task' }, settle: 1500 },
          { plan: 2, do: 'type', target: { role: 'textbox', name: /^Title/ }, text: title },
          { plan: 3, do: 'click', target: SAVE, settle: 1800 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from subtasks where task_id = ${t.id} and title = ${lit(title)}`).length === 1,
      }
    },
    close_task: async ({ rng, sh }) => {
      const t = pickTask(sh, rng)
      if (!t) return null
      return {
        goal: rng.pick([`Close the task "${t.title}".`, `"${t.title}" in ${t.project} is finished. Close it.`]),
        start: taskPath(t), answer: `Closed "${t.title}".`,
        plan: [{ title: 'Click Close this task', check: 'a confirmation is shown' }, { title: 'Confirm with Yes', check: 'text "closed"' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'link', name: 'Close this task' }, settle: 1500 },
          { plan: 2, do: 'click', target: { role: 'button', name: 'Yes' }, settle: 1800 },
        ],
        verify: async ({ sh }) => sql(sh, `select is_active from tasks where id = ${t.id}`)[0][0] === '0',
      }
    },
    search_tasks: async ({ rng, sh }) => {
      const t = pickTask(sh, rng)
      if (!t) return null
      const word = t.title.split(/\s+/).filter((w) => w.length > 4 && /^[A-Za-z]+$/.test(w))[0]
      if (!word) return null
      return {
        goal: rng.pick([`Search the ${t.project} board for tasks about "${word}".`, `Filter ${t.project} to show only tasks matching ${word}.`]),
        start: boardPath(t.projectId), answer: `Showing ${t.project} tasks that match "${word}".`,
        plan: [{ title: `Type ${word} in the Filter box`, check: `textbox "Filter" = ${word}` }, { title: 'Press Enter', check: `text "${t.title}"` }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Filter' }, text: word },
          { plan: 2, do: 'press', key: 'Enter', settle: 1800 },
        ],
        verify: async ({ snapshot }) => snapshot.includes(t.title),
        writes: false,
      }
    },
    read_due: async ({ rng, sh }) => {
      const t = pickTask(sh, rng, 't.date_due > 0')
      if (!t) return null
      const d = new Date(t.due * 1000)
      return {
        goal: rng.pick([`When is "${t.title}" due?`, `What is the due date of the task "${t.title}" in ${t.project}?`]),
        start: boardPath(t.projectId), answer: `"${t.title}" is due on ${human(d)}.`,
        plan: [{ title: `Open the task "${t.title}"`, check: `heading "${t.title}"` }, { title: 'Read the due date', check: 'text "Due date:"' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'link', name: t.title }, settle: 1800 }],
        verify: async ({ snapshot }) => snapshot.includes(t.title) && /Due date/i.test(snapshot),
        writes: false,
      }
    },
    read_assignee: async ({ rng, sh }) => {
      const t = pickTask(sh, rng)
      if (!t) return null
      return {
        goal: rng.pick([`Who is working on "${t.title}"?`, `Who is the assignee of "${t.title}" in ${t.project}?`]),
        start: boardPath(t.projectId), answer: t.owner ? `${t.owner} is assigned to "${t.title}".` : `"${t.title}" is not assigned to anyone.`,
        plan: [{ title: `Open the task "${t.title}"`, check: `heading "${t.title}"` }, { title: 'Read the assignee', check: 'text "Assignee:"' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'link', name: t.title }, settle: 1800 }],
        verify: async ({ snapshot }) => snapshot.includes(t.title) && (!t.owner || snapshot.includes(t.owner)),
        writes: false,
      }
    },
  },
}
