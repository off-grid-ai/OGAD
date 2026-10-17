// Gitea on git.farm.test: GitHub-like forge (sqlite + repos in /dev/shm, data-dir reset).
// Persona meera.iyer: member of all three orgs (owner of orbit-labs and open-tools) and two own repos.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
export const ME = 'meera.iyer'
const ORIGIN = 'http://git.farm.test'
const DB = '/dev/shm/clone-farm/gitea/data/gitea.db'

/** Rows of a read query on the live Gitea DB. */
function sql(sh, q) {
  const out = sh(`sqlite3 -separator '\t' ${DB} <<'SQL'\n.timeout 5000\n${q}\nSQL`)
  return out.split('\n').filter(Boolean).map((l) => l.split('\t'))
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const meId = (sh) => sql(sh, `select id from user where lower_name = ${lit(ME)}`)[0][0]

/** Repos the persona can write to: [owner, name, id, description]. adminOnly: owner-team or own repos. */
function myRepos(sh, adminOnly = false) {
  const rows = sql(sh, `select owner_name, name, id, description from repository`)
  const admin = ['orbit-labs', 'open-tools', ME]
  return rows.filter((r) => !adminOnly || admin.includes(r[0]))
}
/** Issues (not PRs) of a repo: [index, title, is_closed, id]. Newest first, like the list page. */
const issuesOf = (sh, repoId, { open = null, limit = 15 } = {}) => sql(sh, `select "index", name, is_closed, id from issue where repo_id = ${repoId} and is_pull = 0
  ${open === null ? '' : `and is_closed = ${open ? 0 : 1}`} order by created_unix desc limit ${limit}`)
function pickIssue(sh, rng, opts = {}) {
  for (let t = 0; t < 8; t++) {
    const repo = rng.pick(myRepos(sh, opts.adminOnly))
    const list = issuesOf(sh, repo[2], opts)
    if (list.length) { const [index, title, closed, id] = rng.pick(list); return { repo, index, title, closed: closed === '1', id } }
  }
  return null
}
const issuePath = (i) => `/${i.repo[0]}/${i.repo[1]}/issues/${i.index}`
const ref = (i) => `${i.repo[1]}#${i.index}`

const AREAS = ['login', 'search', 'checkout', 'settings page', 'dashboard', 'export', 'notifications', 'sync', 'onboarding', 'profile page', 'API client', 'invoice upload', 'dark mode', 'date picker', 'payments', 'CSV import']
const TITLES = ['{a} breaks on slow networks', 'Add a loading state to {a}', '{a} shows a blank page after logout', 'Improve error text in {a}', 'Support Tamil in {a}',
  'Write tests for {a}', '{a} double-submits the form', 'Add rate limits to {a}', 'Cache {a} responses', '{a} misaligned on small screens']
const BODIES = ['Seen on staging today. Steps: open the {a}, then refresh twice.', 'Customers asked for this in the last two calls.', 'Low effort, good first issue for new joiners.',
  'Blocking the next release. See the logs in the incident channel.', 'Repro rate is about 1 in 5 on Android.']
const COMMENTS = ['I can take this one this week.', 'Reproduced on the latest main.', 'Fixed on my branch, PR coming soon.', 'Can we get a screenshot?', 'This also affects the mobile app.',
  'Moving this to the next milestone.', 'Thanks, this looks good to me.', 'Let us discuss in the Thursday sync.', 'Needs a design review first.', 'Confirmed, raising the priority.']
const fill = (rng, t) => t.replace('{a}', rng.pick(AREAS))
const cap = (s) => s[0].toUpperCase() + s.slice(1)

export default {
  name: 'gitea',
  family: 'code',
  origin: ORIGIN,
  portOffset: 21,
  explorePaths: ['/', '/explore/repos', '/orbit-labs', '/issues', '/pulls', '/monsoon-retail/storefront', '/open-tools/csv-kit/issues'],
  async reset({ sh }) { sh('bash /workspace/action-data-gen/scripts/clones/farm/gitea/reset.sh') },
  async login({ page, sleep }) {
    await page.context().clearCookies()
    await page.goto(`${ORIGIN}/user/login`)
    await page.fill('#user_name', ME)
    await page.fill('#password', ACCOUNTS.password)
    await Promise.all([page.waitForURL((u) => !u.pathname.startsWith('/user/login'), { timeout: 30_000 }), page.keyboard.press('Enter')])
    await sleep(800)
  },
  tasks: {
    create_issue: async ({ rng, sh }) => {
      const repo = rng.pick(myRepos(sh))
      const title = cap(fill(rng, rng.pick(TITLES)))
      const body = fill(rng, rng.pick(BODIES))
      const label = rng.chance(0.5) ? rng.pick(['bug', 'enhancement', 'documentation', 'priority: high', 'good first issue']) : null
      const steps = [
        { plan: 1, do: 'type', target: { role: 'textbox', name: 'Title' }, text: title },
        { plan: 2, do: 'type', target: { role: 'textbox', name: /description|comment/i }, text: body },
      ]
      if (label) steps.push({ plan: 3, do: 'click', target: { role: 'combobox', text: /^Labels/ } }, { plan: 3, do: 'click', target: { role: 'link', name: new RegExp(`^${esc(label)}\\b`), inside: /Filter Label/, insideDepth: 3 } })
      steps.push({ plan: label ? 4 : 3, do: 'click', target: { role: 'button', name: 'Create Issue' }, settle: 2000 })
      const plan = [{ title: 'Type the issue title', check: `textbox "Title" = ${title}` }, { title: 'Type the description', check: 'the description box has the text' }]
      if (label) plan.push({ title: `Add the label ${label}`, check: `the ${label} label is selected` })
      plan.push({ title: 'Click Create Issue', check: `heading "${title}"` })
      return {
        goal: rng.pick([`Open a new issue in ${repo[0]}/${repo[1]} titled "${title}" with the description "${body}"${label ? ` and the label ${label}` : ''}.`,
          `File an issue on ${repo[1]}: "${title}". Description: ${body}${label ? ` Label it ${label}.` : ''}`]),
        start: `/${repo[0]}/${repo[1]}/issues/new`, answer: `Created the issue "${title}" in ${repo[1]}.`, plan, steps,
        verify: async ({ sh }) => {
          const r = sql(sh, `select i.id from issue i join user u on u.id = i.poster_id where i.repo_id = ${repo[2]} and i.name = ${lit(title)} and i.content = ${lit(body)} and u.lower_name = ${lit(ME)}`)
          if (r.length !== 1) return false
          return !label || sql(sh, `select 1 from issue_label il join label l on l.id = il.label_id where il.issue_id = ${r[0][0]} and l.name = ${lit(label)}`).length === 1
        },
      }
    },
    comment_issue: async ({ rng, sh }) => {
      const issue = pickIssue(sh, rng)
      if (!issue) return null
      const text = rng.pick(COMMENTS)
      return {
        goal: rng.pick([`Comment "${text}" on issue ${ref(issue)} ("${issue.title}").`, `Reply to the issue "${issue.title}" in ${issue.repo[1]} with: ${text}`]),
        start: issuePath(issue), answer: `Commented on ${ref(issue)}.`,
        plan: [{ title: 'Type the comment', check: `textbox "Leave a comment" = ${text}` }, { title: 'Click Comment', check: `text "${text}"` }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Leave a comment' }, text },
          { plan: 2, do: 'click', target: { role: 'button', name: 'Comment' }, settle: 2000 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from comment c join user u on u.id = c.poster_id where c.issue_id = ${issue.id} and c.type = 0 and c.content = ${lit(text)} and u.lower_name = ${lit(ME)}`).length === 1,
      }
    },
    close_issue: async ({ rng, sh }) => {
      const issue = pickIssue(sh, rng, { open: true })
      if (!issue) return null
      return {
        goal: rng.pick([`Close issue ${ref(issue)}.`, `The issue "${issue.title}" in ${issue.repo[1]} is done. Close it.`, `Mark "${issue.title}" (${issue.repo[0]}/${issue.repo[1]}) as closed.`]),
        start: issuePath(issue), answer: `Closed ${ref(issue)}.`,
        plan: [{ title: 'Click Close Issue', check: 'text "Closed"' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'button', name: 'Close Issue' }, settle: 2000 }],
        verify: async ({ sh }) => sql(sh, `select is_closed from issue where id = ${issue.id}`)[0][0] === '1',
      }
    },
    reopen_issue: async ({ rng, sh }) => {
      const issue = pickIssue(sh, rng, { open: false })
      if (!issue) return null
      return {
        goal: rng.pick([`Reopen issue ${ref(issue)}.`, `The bug "${issue.title}" in ${issue.repo[1]} is back. Reopen the issue.`]),
        start: issuePath(issue), answer: `Reopened ${ref(issue)}.`,
        plan: [{ title: 'Click Reopen Issue', check: 'text "Open"' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'button', name: 'Reopen Issue' }, settle: 2000 }],
        verify: async ({ sh }) => sql(sh, `select is_closed from issue where id = ${issue.id}`)[0][0] === '0',
      }
    },
    add_label: async ({ rng, sh }) => {
      const issue = pickIssue(sh, rng)
      if (!issue) return null
      const have = sql(sh, `select l.name from issue_label il join label l on l.id = il.label_id where il.issue_id = ${issue.id}`).map((r) => r[0])
      const options = sql(sh, `select name from label where repo_id = ${issue.repo[2]}`).map((r) => r[0]).filter((n) => !have.includes(n))
      if (!options.length) return null
      const label = rng.pick(options)
      return {
        goal: rng.pick([`Add the "${label}" label to issue ${ref(issue)}.`, `Label "${issue.title}" in ${issue.repo[1]} as ${label}.`]),
        start: issuePath(issue), answer: `Added the ${label} label to ${ref(issue)}.`,
        plan: [{ title: 'Open the Labels menu in the sidebar', check: 'the label list is shown' }, { title: `Pick ${label}`, check: `${label} is checked` }, { title: 'Close the menu to save', check: `link "${label}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'combobox', text: /^Labels/ } },
          { plan: 2, do: 'click', target: { role: 'link', name: new RegExp(`^${esc(label)}\\b`), inside: /Filter Label/, insideDepth: 3 } },
          { plan: 3, do: 'click', target: { role: 'combobox', text: /^Labels/ }, settle: 2000 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from issue_label il join label l on l.id = il.label_id where il.issue_id = ${issue.id} and l.name = ${lit(label)}`).length === 1,
      }
    },
    assign_issue: async ({ rng, sh }) => {
      const issue = pickIssue(sh, rng, { open: true })
      if (!issue) return null
      const have = sql(sh, `select assignee_id from issue_assignees where issue_id = ${issue.id}`).map((r) => r[0])
      const who = rng.chance(0.4) ? [meId(sh), ME, sql(sh, `select full_name from user where lower_name = ${lit(ME)}`)[0][0]] : null
      // Anyone with write access to the repo: the org's team members (or the collaborators of a user repo).
      const cands = who ? [who] : sql(sh, `select distinct u.id, u.lower_name, u.full_name from user u join team_user tu on tu.uid = u.id join team t on t.id = tu.team_id
        join user o on o.id = t.org_id where o.lower_name = ${lit(issue.repo[0])} and u.lower_name <> 'farmadmin'
        union select u.id, u.lower_name, u.full_name from collaboration c join user u on u.id = c.user_id where c.repo_id = ${issue.repo[2]}`)
      const pool = cands.filter((c) => !have.includes(c[0]))
      if (!pool.length) return null
      const [uid, uname, full] = rng.pick(pool)
      return {
        goal: uname === ME ? rng.pick([`Assign issue ${ref(issue)} to me.`, `Take ownership of "${issue.title}" in ${issue.repo[1]} by assigning it to yourself.`])
          : rng.pick([`Assign issue ${ref(issue)} to ${full}.`, `Make ${full} the assignee of "${issue.title}" in ${issue.repo[1]}.`]),
        start: issuePath(issue), answer: `Assigned ${ref(issue)} to ${full}.`,
        plan: [{ title: 'Open the Assignees menu in the sidebar', check: 'the people list is shown' }, { title: `Pick ${full}`, check: `${full} is checked` }, { title: 'Close the menu to save', check: `link "${full}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'combobox', text: /^Assignees/ } },
          { plan: 2, do: 'click', target: { role: 'link', name: new RegExp(esc(uname)), inside: /Filter Assignee/, insideDepth: 3, only: true } },
          { plan: 3, do: 'click', target: { role: 'combobox', text: /^Assignees/ }, settle: 2000 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from issue_assignees where issue_id = ${issue.id} and assignee_id = ${uid}`).length === 1,
      }
    },
    star_repo: async ({ rng, sh }) => {
      const me = meId(sh)
      const pool = sql(sh, `select owner_name, name, id from repository where id not in (select repo_id from star where uid = ${me})`)
      if (!pool.length) return null
      const [owner, name, id] = rng.pick(pool)
      return {
        goal: rng.pick([`Star the ${owner}/${name} repository.`, `Give ${name} a star.`, `Bookmark the repo ${name} with a star.`]),
        start: `/${owner}/${name}`, answer: `Starred ${owner}/${name}.`,
        plan: [{ title: 'Click Star', check: 'button "Unstar"' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'button', name: /^Star\b/ }, settle: 1500 }],
        verify: async ({ sh }) => sql(sh, `select 1 from star where uid = ${me} and repo_id = ${id}`).length === 1,
      }
    },
    search_repos: async ({ rng, sh }) => {
      const word = rng.pick(['api', 'sync', 'kestrel', 'atlas', 'csv', 'cron', 'pdf', 'pricing', 'inventory', 'portal', 'pipeline', 'design', 'store', 'notes', 'markdown', 'rupee'])
      const hits = sql(sh, `select owner_name || '/' || name from repository where lower_name like ${lit(`%${word}%`)} or lower(description) like ${lit(`%${word}%`)} order by name`).map((r) => r[0])
      if (!hits.length) return null
      return {
        goal: rng.pick([`Search the repositories for "${word}".`, `Which repos match "${word}"?`, `Find repositories about ${word}.`]),
        start: '/explore/repos', answer: `Repositories matching "${word}": ${hits.join(', ')}.`,
        plan: [{ title: `Type ${word} in the repository search`, check: `the search box contains ${word}` }, { title: 'Press Enter', check: `link "${hits[0].split('/')[1]}"` }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'searchbox', name: /^Search repos/ }, text: word },
          { plan: 2, do: 'press', key: 'Enter', settle: 2000 },
        ],
        verify: async ({ snapshot }) => hits.every((h) => snapshot.includes(h.split('/')[1])),
        writes: false,
      }
    },
    create_milestone: async ({ rng, sh }) => {
      const repo = rng.pick(myRepos(sh, true))
      const title = `${rng.pick(['v2.1', 'v2.2', 'v3.0', 'Sprint 42', 'Sprint 43', 'Holiday freeze', 'Q1 2027', 'Beta 2', 'Security fixes'])}`
      if (sql(sh, `select 1 from milestone where repo_id = ${repo[2]} and name = ${lit(title)}`).length) return null
      const desc = rng.pick(['Bugs and polish before the release.', 'Everything we promised the store team.', 'Performance and stability work.', 'Last features before the freeze.'])
      return {
        goal: rng.pick([`Create a milestone "${title}" in ${repo[0]}/${repo[1]} with the description "${desc}".`, `Add a new milestone called ${title} to ${repo[1]}. Description: ${desc}`]),
        start: `/${repo[0]}/${repo[1]}/milestones/new`, answer: `Created the milestone ${title} in ${repo[1]}.`,
        plan: [{ title: 'Type the milestone title', check: `textbox "Title" = ${title}` }, { title: 'Type the description', check: 'the description has the text' }, { title: 'Click Create Milestone', check: `text "${title}"` }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Title' }, text: title },
          { plan: 2, do: 'type', target: { role: 'textbox', name: /description/i }, text: desc },
          { plan: 3, do: 'click', target: { role: 'button', name: 'Create Milestone' }, settle: 2000 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from milestone where repo_id = ${repo[2]} and name = ${lit(title)} and content = ${lit(desc)}`).length === 1,
      }
    },
    edit_repo_description: async ({ rng, sh }) => {
      const repo = rng.pick(myRepos(sh, true))
      const desc = rng.pick(['Service for {x}, maintained by the platform team', 'Experimental: {x} rewrite', '{x} tooling, see the docs folder', 'Internal {x} library'])
        .replace('{x}', repo[1].replace(/-/g, ' '))
      return {
        goal: rng.pick([`Change the description of ${repo[0]}/${repo[1]} to "${desc}".`, `Update the ${repo[1]} repo description to: ${desc}`]),
        start: `/${repo[0]}/${repo[1]}/settings`, answer: `The description of ${repo[1]} is now "${desc}".`,
        plan: [{ title: 'Replace the text in the Description box', check: `textbox "Description" = ${desc}` }, { title: 'Click Update Settings', check: 'text "Your settings have been updated"' }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Description' }, text: desc },
          { plan: 2, do: 'click', target: { role: 'button', name: 'Update Settings', nth: 0, only: true }, settle: 2000 },
        ],
        verify: async ({ sh }) => sql(sh, `select description from repository where id = ${repo[2]}`)[0][0] === desc,
      }
    },
    read_issue: async ({ rng, sh }) => {
      const issue = pickIssue(sh, rng, { limit: 10 })
      if (!issue) return null
      const assignees = sql(sh, `select u.full_name from issue_assignees a join user u on u.id = a.assignee_id where a.issue_id = ${issue.id} order by u.full_name`).map((r) => r[0])
      const state = issue.closed ? 'closed' : 'open'
      const ask = rng.pick(['status', 'assignee'])
      const answer = ask === 'status' ? `Issue "${issue.title}" is ${state}.` : (assignees.length ? `"${issue.title}" is assigned to ${assignees.join(' and ')}.` : `"${issue.title}" has no assignee.`)
      return {
        goal: ask === 'status' ? rng.pick([`Is the issue "${issue.title}" in ${issue.repo[1]} open or closed?`, `What is the status of "${issue.title}" in ${issue.repo[0]}/${issue.repo[1]}?`])
          : rng.pick([`Who is assigned to the issue "${issue.title}" in ${issue.repo[1]}?`, `Find out who owns "${issue.title}" in ${issue.repo[0]}/${issue.repo[1]}.`]),
        start: `/${issue.repo[0]}/${issue.repo[1]}/issues?state=${state}`, answer,
        plan: [{ title: `Open the issue "${issue.title}"`, check: `heading "${issue.title} #${issue.index}"` }, { title: `Read the ${ask}`, check: ask === 'status' ? `text "${state === 'open' ? 'Open' : 'Closed'}"` : 'the Assignees section' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'link', name: issue.title }, settle: 1800 }],
        verify: async ({ page }) => page.url().endsWith(`/issues/${issue.index}`),
        writes: false,
      }
    },
  },
}
