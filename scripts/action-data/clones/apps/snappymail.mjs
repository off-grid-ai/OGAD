// SnappyMail on webmail.farm.test: a second webmail UI over the same mail stack. HELD-OUT TEST APP.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PEOPLE as ALL, FOLDERS, readBox, inFolder, received, COMPOSE, REPLIES, invoiceFacts } from './mail-common.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
// SnappyMail runs as its own persona, so its runs never touch Roundcube's mailbox.
const ME = { name: 'Rohan Kapoor', email: 'rohan.kapoor@farm.test' }
const PEOPLE = ALL.filter((p) => p.email !== ME.email)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Inbox messages on the first page (20 newest) whose subject is unique there. */
function firstPage(filter = () => true) {
  const top = readBox(ME.email).slice(0, 20)
  const count = {}
  for (const m of top) count[m.subject] = (count[m.subject] ?? 0) + 1
  return top.filter((m) => count[m.subject] === 1 && filter(m))
}
const colleague = (m) => PEOPLE.some((p) => p.email === m.fromEmail)
// SnappyMail's list rows and toolbar are generics: the subject is the row text, actions carry a title.
const openMsg = (m, plan = 1) => ({ plan, do: 'click', target: { role: 'generic', value: m.subject }, settle: 2000 })
const openTitle = (m) => ({ title: `Open the email "${m.subject}"`, check: `text "${m.subject}"` })
const toField = { role: 'combobox', name: '', inside: /^To\b/, insideRole: 'row' }
const subjectField = { role: 'textbox', name: '', inside: /^Subject\b/, insideRole: 'row' }
const bodyField = { role: 'textbox', name: '', value: /^(?!#[0-9a-f]{6}$)/i, under: /^tabpanel/ }
const sendButton = { role: 'generic', name: '', text: /^\S*\s*Send$/u, under: /^banner/ }
const SENT = 'text "Message sent"'

export default {
  name: 'snappymail',
  family: 'mail',
  origin: 'http://webmail.farm.test',
  async reset({ sh }) { sh(`bash /workspace/clone-farm/mail/reset.sh ${ME.email}`) },
  async login({ page, sleep }) {
    await page.goto('http://webmail.farm.test/')
    await sleep(2000)
    if (await page.getByRole('textbox', { name: /email/i }).count()) {
      await page.getByRole('textbox', { name: /email/i }).first().fill(ME.email)
      await page.locator('input[type=password]').first().fill(ACCOUNTS.password)
      await page.keyboard.press('Enter')
      await page.waitForFunction(() => /MailBox/.test(document.title), null, { timeout: 60_000 })
      await sleep(1500)
    }
    // First sign-in asks for the identity name once (kept in SnappyMail's own storage).
    const identity = page.getByRole('dialog').filter({ hasText: 'Edit Identity' })
    if (await identity.isVisible().catch(() => false)) {
      await identity.getByRole('textbox').first().fill(ME.name)
      await identity.getByRole('button', { name: /Save/ }).click()
      await sleep(1500)
    }
  },
  tasks: {
    compose_send: async ({ rng }) => {
      const t0 = Date.now()
      const p = rng.pick(PEOPLE)
      const [subject, body] = rng.pick(COMPOSE)
      return {
        goal: rng.pick([`Send an email to ${p.email} with the subject "${subject}" that says: ${body}`, `Email ${p.name} (${p.email}). Subject: ${subject}. Message: ${body}`]),
        start: '/', answer: `Sent "${subject}" to ${p.email}`,
        plan: [{ title: 'Click New message', check: 'the new message form is shown' }, { title: `Type ${p.email} in To`, check: `${p.email} is in To` }, { title: `Type ${subject} in Subject`, check: `the subject is ${subject}` }, { title: 'Type the message', check: 'the message text is filled in' }, { title: 'Click Send', check: SENT }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'generic', name: 'New message' }, settle: 2000 },
          { plan: 2, do: 'type', target: toField, text: p.email },
          { plan: 3, do: 'type', target: subjectField, text: subject },
          { plan: 4, do: 'type', target: bodyField, text: body },
          { plan: 5, do: 'click', target: sendButton, settle: 3000 }
        ],
        verify: async () => received(p.email, (m) => m.subject === subject && m.fromEmail === ME.email, t0)
      }
    },
    reply_send: async ({ rng }) => {
      const t0 = Date.now()
      const m = rng.pick(firstPage(colleague))
      if (!m) return null
      const reply = rng.pick(REPLIES)
      return {
        goal: rng.pick([`Reply to the email "${m.subject}" from ${m.fromName} and say: ${reply}`, `Answer ${m.fromName.split(' ')[0]}'s mail about "${m.subject}" with "${reply}".`]),
        start: '/', answer: `Replied to ${m.fromName}: ${reply}`,
        plan: [openTitle(m), { title: 'Click Reply', check: 'the reply form is shown' }, { title: 'Type the reply', check: 'the reply text is filled in' }, { title: 'Click Send', check: SENT }],
        steps: [openMsg(m), { plan: 2, do: 'click', target: { role: 'generic', name: 'Reply' }, settle: 2000 }, { plan: 3, do: 'type', target: bodyField, text: reply }, { plan: 4, do: 'click', target: sendButton, settle: 3000 }],
        verify: async () => received(m.fromEmail, (x) => x.subject === `Re: ${m.subject}` && x.body.includes(reply), t0)
      }
    },
    archive_one: async ({ rng }) => {
      const m = rng.pick(firstPage())
      if (!m) return null
      return {
        goal: rng.pick([`Archive the email "${m.subject}".`, `Move "${m.subject}" from ${m.fromName} to the archive.`]),
        start: '/', answer: `Archived "${m.subject}"`,
        plan: [openTitle(m), { title: 'Click Archive', check: `the email "${m.subject}" is not in Inbox` }],
        steps: [openMsg(m), { plan: 2, do: 'click', target: { role: 'generic', name: 'Archive' } }],
        verify: async () => inFolder(FOLDERS.archive, m.id, ME.email) && !inFolder(FOLDERS.inbox, m.id, ME.email)
      }
    },
    delete_one: async ({ rng }) => {
      const m = rng.pick(firstPage((x) => !colleague(x)))
      if (!m) return null
      return {
        goal: rng.pick([`Delete the email "${m.subject}".`, `Throw away the mail "${m.subject}".`]),
        start: '/', answer: `Deleted "${m.subject}"`,
        plan: [openTitle(m), { title: 'Click Delete', check: `the email "${m.subject}" is not in Inbox` }],
        steps: [openMsg(m), { plan: 2, do: 'click', target: { role: 'generic', name: 'Delete' } }],
        verify: async () => inFolder(FOLDERS.trash, m.id, ME.email) && !inFolder(FOLDERS.inbox, m.id, ME.email)
      }
    },
    spam_one: async ({ rng }) => {
      const m = rng.pick(firstPage((x) => !colleague(x)))
      if (!m) return null
      return {
        goal: rng.pick([`Mark the email "${m.subject}" as spam.`, `Move "${m.subject}" to Spam.`]),
        start: '/', answer: `Moved "${m.subject}" to Spam`,
        plan: [openTitle(m), { title: 'Click Move message(s) to Spam', check: `the email "${m.subject}" is not in Inbox` }],
        steps: [openMsg(m), { plan: 2, do: 'click', target: { role: 'generic', name: 'Move message(s) to Spam' } }],
        verify: async () => inFolder(FOLDERS.junk, m.id, ME.email) && !inFolder(FOLDERS.inbox, m.id, ME.email)
      }
    },
    star_one: async ({ rng }) => {
      const m = rng.pick(firstPage((x) => !x.flagged))
      if (!m) return null
      return {
        goal: rng.pick([`Star the email "${m.subject}".`, `Flag "${m.subject}" so I remember it.`]),
        start: '/', answer: `Starred "${m.subject}"`,
        plan: [{ title: `Click the star on "${m.subject}"`, check: 'the email is starred' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'generic', value: '☆', inside: new RegExp(esc(m.subject)), insideDepth: 1 } }],
        verify: async () => readBox(ME.email).some((x) => x.id === m.id && x.flagged)
      }
    },
    invoice_read: async ({ rng }) => {
      const m = rng.pick(readBox(ME.email).filter((x) => /^Invoice INV-\d+/.test(x.subject)))
      const f = invoiceFacts(m)
      const ask = rng.pick(['amount', 'due', 'paid'])
      return {
        goal: { amount: `What is the amount of invoice ${f.num}?`, due: `When is invoice ${f.num} due?`, paid: `Is invoice ${f.num} paid?` }[ask],
        answer: { amount: `Invoice ${f.num} is for Rs ${f.amount}`, due: `Invoice ${f.num} is due on ${f.due}`, paid: f.paid ? `Yes, invoice ${f.num} has been paid` : `No, invoice ${f.num} is still due (${f.due})` }[ask],
        start: '/', writes: false,
        plan: [{ title: `Type ${f.num} in Search`, check: `searchbox "Search" = ${f.num}` }, { title: 'Press Enter to search', check: `text "${m.subject}"` }, { title: `Open the email "${m.subject}"`, check: `text "Rs ${f.amount}"` }],
        steps: [{ plan: 1, do: 'type', target: { role: 'searchbox', name: 'Search' }, text: f.num }, { plan: 2, do: 'press', key: 'Enter', settle: 2000 }, { plan: 3, do: 'click', target: { role: 'generic', value: m.subject }, settle: 2000 }],
        verify: async ({ snapshot }) => snapshot.includes(`Rs ${f.amount}`) && snapshot.includes(f.due)
      }
    },
    forward: async ({ rng }) => {
      const t0 = Date.now()
      const m = rng.pick(firstPage())
      if (!m) return null
      const p = rng.pick(PEOPLE)
      return {
        goal: rng.pick([`Forward the email "${m.subject}" to ${p.email}.`, `Send "${m.subject}" on to ${p.name} at ${p.email}.`]),
        start: '/', answer: `Forwarded "${m.subject}" to ${p.email}`,
        plan: [openTitle(m), { title: 'Open the message actions menu', check: 'the actions menu is shown' }, { title: 'Click Forward', check: 'the forward form is shown' }, { title: `Type ${p.email} in To`, check: `${p.email} is in To` }, { title: 'Click Send', check: SENT }],
        steps: [openMsg(m), { plan: 2, do: 'click', target: { role: 'link', name: '☰', inside: /Reply/, insideDepth: 3 } }, { plan: 3, do: 'click', target: { role: 'link', name: /Forward$/ }, settle: 2000 }, { plan: 4, do: 'type', target: toField, text: p.email }, { plan: 5, do: 'click', target: sendButton, settle: 3000 }],
        verify: async () => received(p.email, (x) => x.subject === `Fwd: ${m.subject}` && x.fromEmail === ME.email, t0)
      }
    }
  }
}
