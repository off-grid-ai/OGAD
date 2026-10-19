// Synthetic Trello-like workspace for the tasks clone (Planka v2 on tasks.farm.test, API on 127.0.0.1:7153).
//   node tasks_seed.mjs
// 25 users, 3 projects, 6 boards, ~430 cards with labels, members, due dates, checklists (task lists) and comments.
// Every account uses the farm test password. The main persona is asha.rao (project owner, editor on every board).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRng } from '../../rng.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PASS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8')).password
const API = process.env.PLANKA_API ?? 'http://127.0.0.1:7153/api'
const R = createRng('tasks-seed-20261016')

async function call(token, method, path, body) {
  const r = await fetch(API + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) { const e = new Error(`${method} ${path} ${r.status} ${JSON.stringify(j).slice(0, 300)}`); e.body = j; e.status = r.status; throw e }
  return j
}
async function login(user) {
  try { return (await call(null, 'POST', '/access-tokens', { emailOrUsername: user, password: PASS })).item } catch (e) {
    const pending = e.body?.pendingToken
    if (!pending) throw e
    const terms = await call(null, 'GET', '/terms?type=general').catch(() => call(null, 'GET', '/terms'))
    return (await call(null, 'POST', '/access-tokens/accept-terms', { pendingToken: pending, signature: terms.item.signature })).item
  }
}

const FIRST = ['Asha', 'Rohan', 'Meera', 'Kabir', 'Priya', 'Arjun', 'Neha', 'Vikram', 'Isha', 'Dev', 'Ananya', 'Karan', 'Tara', 'Nikhil', 'Sana', 'Rahul', 'Leela', 'Aditya', 'Zoya', 'Farhan', 'Elena', 'Lucas', 'Hana', 'Mateo', 'Grace']
const LAST = ['Rao', 'Mehta', 'Iyer', 'Khan', 'Nair', 'Sharma', 'Das', 'Kapoor', 'Joshi', 'Bose', 'Pillai', 'Singh', 'Menon', 'Reddy', 'Gupta', 'Ali', 'Fernandes', 'Chatterjee', 'Kulkarni', 'Banerjee', 'Shah', 'Verma', 'Patel', 'Rossi', 'Silva']

const BOARDS = {
  Product: {
    'Mobile App Launch': ['Onboarding screens', 'Push notification opt-in', 'Crash on Android 12 login', 'Dark mode colours', 'App Store screenshots', 'Offline sync for drafts', 'Payment sheet redesign', 'Deep links from email', 'Biometric login', 'Reduce cold start time', 'Accessibility labels audit', 'Release notes v2.4', 'Beta tester feedback triage', 'Fix keyboard covering input', 'In-app review prompt', 'Analytics events for checkout', 'Tablet layout', 'Localise to Hindi', 'Image upload compression', 'Session timeout handling'],
    'Website Redesign': ['New homepage hero', 'Pricing page copy', 'Blog template', 'Navigation menu IA', 'Footer links cleanup', 'Contact form spam filter', 'Case study pages', 'SEO meta tags', 'Cookie banner', 'Page speed audit', 'Careers page', 'Customer logos strip', 'Signup flow A/B test', '404 page', 'Docs search', 'Brand colour tokens', 'Image CDN setup', 'Testimonials carousel', 'Mobile menu bug', 'Analytics dashboard embed']
  },
  Operations: {
    'Office Move': ['Shortlist office spaces', 'Sign lease for Baner office', 'Internet line booking', 'Desk and chair order', 'Meeting room AV setup', 'Access cards for staff', 'Pantry vendor', 'Movers quotation', 'Fire safety audit', 'Parking passes', 'Plants and decor', 'Wi-Fi survey', 'Printer lease', 'Housekeeping contract', 'Signage at entrance', 'Update address with GST', 'Insurance for equipment', 'Server rack move', 'Farewell to old office', 'Seating plan'],
    'Hiring Pipeline': ['Senior Android engineer', 'Product designer', 'QA lead', 'Data analyst', 'Customer success manager', 'Backend intern', 'DevOps engineer', 'Content writer', 'Sales lead – Mumbai', 'Finance associate', 'HR generalist', 'Frontend engineer', 'Engineering manager', 'Recruiter contract', 'Campus drive at COEP', 'Referral bonus policy', 'Interview scorecards', 'Offer letter template', 'Background check vendor', 'Onboarding buddy list']
  },
  Marketing: {
    'Q4 Campaigns': ['Diwali sale landing page', 'Email: festive offers', 'Instagram reels plan', 'Influencer shortlist', 'Google Ads budget', 'Retargeting audience', 'Webinar: AI for teams', 'Press release draft', 'Partner co-marketing', 'Customer stories video', 'Year-end newsletter', 'Referral campaign', 'LinkedIn carousel', 'Billboard in Pune', 'Podcast sponsorship', 'Discount code tracking', 'Survey for NPS', 'Product Hunt launch', 'Holiday social calendar', 'Campaign report'],
    'Content Calendar': ['Blog: 10 tips for remote teams', 'Blog: Monsoon productivity', 'Guide: Getting started', 'Video: Product tour', 'Ebook: Hiring playbook', 'Blog: Security checklist', 'Newsletter October', 'Case study: Northwind', 'Infographic: Survey results', 'Blog: Release roundup', 'Webinar recap post', 'Twitter thread: launch', 'Glossary page', 'FAQ refresh', 'Guest post outreach', 'Blog: Customer interview', 'Translate top posts', 'Update old screenshots', 'Blog: Year in review', 'Style guide update']
  }
}
const LISTS = ['Backlog', 'To Do', 'In Progress', 'Review', 'Done']
const LABELS = [['Bug', 'berry-red'], ['Feature', 'lagoon-blue'], ['Urgent', 'pumpkin-orange'], ['Design', 'pink-tulip'], ['Backend', 'midnight-blue'], ['Research', 'sunny-grass'], ['Blocked', 'dark-granite'], ['Quick win', 'fresh-salad']]
const SUFFIX = ['', ' (phase 2)', ' – follow-up', ' for Q1', ' v2', ' review', ' – Bengaluru', ' – Pune']
const DESCS = ['Owner to confirm scope by Friday.', 'See the linked doc for details.', 'Customer asked for this twice.', 'Needs sign-off from finance.', 'Low effort, high impact.', 'Blocked on vendor reply.', 'Draft is ready for review.', '']
const COMMENTS = ['Started on this today.', 'Can we move the due date by a week?', 'Shared the draft in the channel.', 'Looks good to me.', 'Waiting on the vendor for a quote.', 'Added notes from the call.', 'Please review when you have time.', 'Done from my side.', 'This depends on the API change.', 'Let us discuss in standup.']
const TASKS = ['Draft', 'Review with team', 'Get approval', 'Update the doc', 'Share with stakeholders', 'Test on staging', 'Book a meeting', 'Collect quotes', 'Send invite', 'Write summary']

const admin = await login('farmadmin')
const T = admin
const users = []
const existing = (await call(T, 'GET', '/users')).items
for (let i = 0; i < 25; i++) {
  const username = `${FIRST[i].toLowerCase()}.${LAST[i].toLowerCase()}`
  let u = existing.find((x) => x.username === username)
  if (!u) u = (await call(T, 'POST', '/users', { email: `${username}@farm.test`, password: PASS, role: i === 0 ? 'projectOwner' : 'boardUser', name: `${FIRST[i]} ${LAST[i]}`, username, organization: 'Northwind Labs' })).item
  users.push(u)
}
const tokens = {}
for (const u of users) tokens[u.id] = await login(u.username)
console.log('users', users.length)

const day = 86400000
const base = Date.parse('2026-10-16T12:00:00+05:30')
let nCards = 0; let nComments = 0; let nTasks = 0
let bpos = 0
for (const [projectName, boards] of Object.entries(BOARDS)) {
  const project = (await call(T, 'POST', '/projects', { type: 'shared', name: projectName, description: `${projectName} team work` })).item
  await call(T, 'POST', `/projects/${project.id}/project-managers`, { userId: users[0].id }).catch(() => {})
  for (const [boardName, titles] of Object.entries(boards)) {
    const board = (await call(T, 'POST', `/projects/${project.id}/boards`, { name: boardName, position: 65536 * ++bpos })).item
    const members = [users[0], ...R.sample(users.slice(1), 11)]
    for (const m of members) await call(T, 'POST', `/boards/${board.id}/board-memberships`, { userId: m.id, role: 'editor' }).catch((e) => { if (!/already|409|conflict/i.test(e.message)) throw e })
    const labels = []
    for (const [i, [name, color]] of LABELS.entries()) labels.push((await call(T, 'POST', `/boards/${board.id}/labels`, { name, color, position: 65536 * (i + 1) })).item)
    const lists = []
    for (const [i, name] of LISTS.entries()) lists.push((await call(T, 'POST', `/boards/${board.id}/lists`, { name, type: 'active', position: 65536 * (i + 1) })).item)
    const seen = new Set()
    const n = 72
    for (let c = 0; c < n; c++) {
      let name
      for (let t = 0; t < 30; t++) { name = R.pick(titles) + (c < titles.length ? '' : R.pick(SUFFIX)); if (!seen.has(name)) break }
      if (seen.has(name)) name = `${R.pick(titles)} #${c}`
      seen.add(name)
      const li = c < titles.length ? c % 5 : R.pick([0, 0, 1, 1, 1, 2, 2, 3, 4, 4])
      const due = R.chance(0.6) ? new Date(base + R.int(-30, 60) * day + R.int(9, 18) * 3600000).toISOString() : undefined
      const author = R.pick(members)
      const card = (await call(tokens[author.id], 'POST', `/lists/${lists[li].id}/cards`, { type: 'project', name, position: 65536 * (c + 1), description: R.pick(DESCS) || undefined, ...(due ? { dueDate: due, isDueCompleted: li === 4 } : {}) })).item
      nCards++
      for (const l of R.sample(labels, R.pick([0, 1, 1, 1, 2, 2, 3]))) await call(T, 'POST', `/cards/${card.id}/card-labels`, { labelId: l.id })
      for (const m of R.sample(members, R.pick([0, 1, 1, 2, 2, 3]))) await call(T, 'POST', `/cards/${card.id}/card-memberships`, { userId: m.id })
      if (R.chance(0.4)) {
        const tl = (await call(T, 'POST', `/cards/${card.id}/task-lists`, { name: R.pick(['Checklist', 'Steps', 'To do']), position: 65536 })).item
        const k = R.int(2, 5)
        for (const [i, tn] of R.sample(TASKS, k).entries()) { await call(T, 'POST', `/task-lists/${tl.id}/tasks`, { name: tn, position: 65536 * (i + 1), isCompleted: li === 4 || R.chance(0.35) }); nTasks++ }
      }
      for (let k = R.pick([0, 0, 1, 1, 2, 3]); k > 0; k--) { const who = R.pick(members); await call(tokens[who.id], 'POST', `/cards/${card.id}/comments`, { text: R.pick(COMMENTS) }); nComments++ }
    }
    console.log(boardName, n)
  }
}
console.log(JSON.stringify({ cards: nCards, comments: nComments, tasks: nTasks }))
