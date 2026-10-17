// Roundcube (elastic skin) on mail.farm.test: Gmail-like webmail over dovecot + postfix.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ME, PEOPLE, FOLDERS, readBox, inFolder, received, COMPOSE, REPLIES, invoiceFacts } from './mail-common.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
const RC_DB = '/dev/shm/clone-farm/roundcube/rc.db'

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Elastic puts an icon-font glyph before toolbar names: " Reply". */
const icon = (name) => new RegExp(`^(?:[\\uE000-\\uF8FF]\\s*)?${esc(name)}$`, 'u')

/** Inbox messages on the first page (50 newest) whose subject is unique there. */
function firstPage(filter = () => true) {
  const top = readBox(ME.email).slice(0, 50)
  const count = {}
  for (const m of top) count[m.subject] = (count[m.subject] ?? 0) + 1
  return top.filter((m) => count[m.subject] === 1 && filter(m))
}
const colleague = (m) => PEOPLE.some((p) => p.email === m.fromEmail)
const openMsg = (m, plan = 1) => ({ plan, do: 'click', target: { role: 'link', name: m.subject, under: /table Email Messages Listing/ } })
const openTitle = (m) => ({ title: `Open the email "${m.subject}"`, check: 'the email is shown' })

const toField = { role: 'combobox', name: '', inside: /^To\b/ }

export default {
  name: 'roundcube',
  family: 'mail',
  origin: 'http://mail.farm.test',
  explorePaths: ['/?_task=mail&_mbox=INBOX', '/?_task=addressbook', '/?_task=settings', '/?_task=mail&_mbox=Sent'],
  async reset({ sh }) { sh(`bash /workspace/clone-farm/mail/reset.sh ${ME.email} && cp /workspace/clone-farm/snap/roundcube.db ${RC_DB}`) },
  async login({ page, sleep }) {
    await page.goto('http://mail.farm.test/?_task=logout').catch(() => {})
    await page.goto('http://mail.farm.test/')
    await page.fill('#rcmloginuser', ME.email)
    await page.fill('#rcmloginpwd', ACCOUNTS.password)
    await Promise.all([page.waitForURL(/_task=mail/, { timeout: 30_000 }), page.click('#rcmloginsubmit')])
    await sleep(1000)
  },
  tasks: {
    compose_send: async ({ rng }) => {
      const t0 = Date.now()
      const p = rng.pick(PEOPLE.slice(1))
      const [subject, body] = rng.pick(COMPOSE)
      const goal = rng.pick([
        `Send an email to ${p.email} with the subject "${subject}" that says: ${body}`,
        `Email ${p.name} (${p.email}). Subject: ${subject}. Message: ${body}`,
        `Write a mail to ${p.email} about "${subject}" saying "${body}" and send it.`
      ])
      return {
        goal, start: '/?_task=mail&_mbox=INBOX', answer: `Sent "${subject}" to ${p.email}`,
        plan: [
          { title: 'Click Compose', check: 'url contains _action=compose' },
          { title: `Type ${p.email} in To`, check: `${p.email} is in To` },
          { title: `Type ${subject} in Subject`, check: `textbox "Subject" = ${subject}` },
          { title: 'Type the message in Message Body', check: `textbox "Message Body" = ${body}` },
          { title: 'Click Send', check: 'text "Message sent successfully"' }
        ],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: icon('Compose') }, settle: 2500 },
          { plan: 2, do: 'type', target: toField, text: p.email },
          { plan: 3, do: 'type', target: { role: 'textbox', name: 'Subject' }, text: subject },
          { plan: 4, do: 'type', target: { role: 'textbox', name: 'Message Body' }, text: body },
          { plan: 5, do: 'click', target: { role: 'button', name: icon('Send') }, settle: 2500 }
        ],
        verify: async () => received(p.email, (m) => m.subject === subject && m.fromEmail === ME.email, t0)
      }
    },
    reply_send: async ({ rng }) => {
      const t0 = Date.now()
      const m = rng.pick(firstPage(colleague))
      if (!m) return null
      const reply = rng.pick(REPLIES)
      const first = m.fromName.split(' ')[0]
      return {
        goal: rng.pick([`Reply to the email "${m.subject}" from ${m.fromName} and say: ${reply}`, `Answer ${first}'s mail about "${m.subject}" with "${reply}" and send it.`, `Send a reply to ${m.fromName} on "${m.subject}": ${reply}`]),
        start: '/?_task=mail&_mbox=INBOX', answer: `Replied to ${m.fromName}: ${reply}`,
        plan: [openTitle(m), { title: 'Click Reply', check: 'url contains _action=compose' }, { title: 'Type the reply in Message Body', check: `textbox "Message Body" = ${reply}` }, { title: 'Click Send', check: 'text "Message sent successfully"' }],
        steps: [openMsg(m), { plan: 2, do: 'click', target: { role: 'button', name: icon('Reply') }, settle: 2500 }, { plan: 3, do: 'type', target: { role: 'textbox', name: 'Message Body' }, text: reply }, { plan: 4, do: 'click', target: { role: 'button', name: icon('Send') }, settle: 2500 }],
        verify: async () => received(m.fromEmail, (x) => x.subject === `Re: ${m.subject}` && x.body.includes(reply), t0)
      }
    },
    reply_draft: async ({ rng }) => {
      const m = rng.pick(firstPage(colleague))
      if (!m) return null
      const reply = rng.pick(REPLIES)
      return {
        goal: rng.pick([`Draft a reply to the latest mail "${m.subject}" from ${m.fromName} saying "${reply}". Don't send it.`, `Prepare a reply to ${m.fromName} about "${m.subject}" with the text "${reply}" and save it as a draft.`]),
        start: '/?_task=mail&_mbox=INBOX', answer: `Saved a draft reply to ${m.fromName}`,
        plan: [openTitle(m), { title: 'Click Reply', check: 'url contains _action=compose' }, { title: 'Type the reply in Message Body', check: `textbox "Message Body" = ${reply}` }, { title: 'Click Save', check: 'text "Message saved to Drafts"' }],
        steps: [openMsg(m), { plan: 2, do: 'click', target: { role: 'button', name: icon('Reply') }, settle: 2500 }, { plan: 3, do: 'type', target: { role: 'textbox', name: 'Message Body' }, text: reply }, { plan: 4, do: 'click', target: { role: 'button', name: icon('Save') }, settle: 2000 }],
        verify: async () => readBox(ME.email, FOLDERS.drafts).some((x) => x.subject === `Re: ${m.subject}` && x.body.includes(reply))
      }
    },
    forward: async ({ rng }) => {
      const t0 = Date.now()
      const m = rng.pick(firstPage())
      if (!m) return null
      const p = rng.pick(PEOPLE.slice(1))
      return {
        goal: rng.pick([`Forward the email "${m.subject}" to ${p.email}.`, `Send "${m.subject}" on to ${p.name} at ${p.email}.`]),
        start: '/?_task=mail&_mbox=INBOX', answer: `Forwarded "${m.subject}" to ${p.email}`,
        plan: [openTitle(m), { title: 'Click Forward', check: 'url contains _action=compose' }, { title: `Type ${p.email} in To`, check: `${p.email} is in To` }, { title: 'Click Send', check: 'text "Message sent successfully"' }],
        steps: [openMsg(m), { plan: 2, do: 'click', target: { role: 'button', name: icon('Forward') }, settle: 2500 }, { plan: 3, do: 'type', target: toField, text: p.email }, { plan: 4, do: 'click', target: { role: 'button', name: icon('Send') }, settle: 2500 }],
        verify: async () => received(p.email, (x) => x.subject === `Fwd: ${m.subject}` && x.fromEmail === ME.email, t0)
      }
    },
    archive_one: async ({ rng }) => {
      const m = rng.pick(firstPage())
      if (!m) return null
      return {
        goal: rng.pick([`Archive the email "${m.subject}".`, `Move the mail "${m.subject}" from ${m.fromName} to the archive.`]),
        start: '/?_task=mail&_mbox=INBOX', answer: `Archived "${m.subject}"`,
        plan: [openTitle(m), { title: 'Click Archive', check: `the email "${m.subject}" is not in Inbox` }],
        steps: [openMsg(m), { plan: 2, do: 'click', target: { role: 'button', name: icon('Archive') } }],
        verify: async () => inFolder(FOLDERS.archive, m.id) && !inFolder(FOLDERS.inbox, m.id)
      }
    },
    delete_one: async ({ rng }) => {
      const m = rng.pick(firstPage((x) => !colleague(x)))
      if (!m) return null
      return {
        goal: rng.pick([`Delete the email "${m.subject}".`, `Throw away the mail from ${m.fromName} titled "${m.subject}".`]),
        start: '/?_task=mail&_mbox=INBOX', answer: `Deleted "${m.subject}"`,
        plan: [openTitle(m), { title: 'Click Delete', check: `the email "${m.subject}" is not in Inbox` }],
        steps: [openMsg(m), { plan: 2, do: 'click', target: { role: 'button', name: icon('Delete') } }],
        verify: async () => inFolder(FOLDERS.trash, m.id) && !inFolder(FOLDERS.inbox, m.id)
      }
    },
    junk_one: async ({ rng }) => {
      const m = rng.pick(firstPage((x) => !colleague(x)))
      if (!m) return null
      return {
        goal: rng.pick([`Mark the email "${m.subject}" as spam.`, `Move "${m.subject}" to Junk.`]),
        start: '/?_task=mail&_mbox=INBOX', answer: `Moved "${m.subject}" to Junk`,
        plan: [openTitle(m), { title: 'Click Junk', check: `the email "${m.subject}" is not in Inbox` }],
        steps: [openMsg(m), { plan: 2, do: 'click', target: { role: 'button', name: icon('Junk') } }],
        verify: async () => inFolder(FOLDERS.junk, m.id) && !inFolder(FOLDERS.inbox, m.id)
      }
    },
    flag_one: async ({ rng }) => {
      const m = rng.pick(firstPage((x) => !x.flagged))
      if (!m) return null
      return {
        goal: rng.pick([`Flag the email "${m.subject}".`, `Star the mail "${m.subject}" so I remember it.`]),
        start: '/?_task=mail&_mbox=INBOX', answer: `Flagged "${m.subject}"`,
        plan: [openTitle(m), { title: 'Click Mark', check: 'the Mark menu is shown' }, { title: 'Click As flagged', check: 'the email is flagged' }],
        steps: [openMsg(m), { plan: 2, do: 'click', target: { role: 'button', name: icon('Mark') } }, { plan: 3, do: 'click', target: { role: 'button', name: icon('As flagged') } }],
        verify: async () => readBox(ME.email).some((x) => x.id === m.id && x.flagged)
      }
    },
    mark_unread: async ({ rng }) => {
      const m = rng.pick(firstPage((x) => x.seen))
      if (!m) return null
      return {
        goal: rng.pick([`Mark the email "${m.subject}" as unread.`, `Open "${m.subject}" and set it back to unread.`]),
        start: '/?_task=mail&_mbox=INBOX', answer: `Marked "${m.subject}" as unread`,
        plan: [openTitle(m), { title: 'Click Mark', check: 'the Mark menu is shown' }, { title: 'Click Unread', check: 'the email is unread' }],
        steps: [openMsg(m), { plan: 2, do: 'click', target: { role: 'button', name: icon('Mark') } }, { plan: 3, do: 'click', target: { role: 'button', name: icon('As unread') } }],
        verify: async () => readBox(ME.email).some((x) => x.id === m.id && !x.seen)
      }
    },
    invoice_read: async ({ rng }) => {
      const invoices = readBox(ME.email).filter((m) => /^Invoice INV-\d+/.test(m.subject))
      const m = rng.pick(invoices)
      const f = invoiceFacts(m)
      const ask = rng.pick(['amount', 'due', 'paid'])
      const goal = { amount: `What is the amount of invoice ${f.num}?`, due: `When is invoice ${f.num} due?`, paid: `Is invoice ${f.num} paid?` }[ask]
      const answer = { amount: `Invoice ${f.num} is for Rs ${f.amount}`, due: `Invoice ${f.num} is due on ${f.due}`, paid: f.paid ? `Yes, invoice ${f.num} has been paid` : `No, invoice ${f.num} is still due (${f.due})` }[ask]
      return {
        goal, start: '/?_task=mail&_mbox=INBOX', answer, writes: false,
        plan: [{ title: `Type ${f.num} in Search terms`, check: `textbox "Search terms" = ${f.num}` }, { title: 'Press Enter to search', check: `text "${m.subject}"` }, { title: `Open the email "${m.subject}"`, check: `text "${f.num}"` }],
        steps: [{ plan: 1, do: 'type', target: { role: 'textbox', name: 'Search terms' }, text: f.num }, { plan: 2, do: 'press', key: 'Enter' }, { plan: 3, do: 'click', target: { role: 'link', name: m.subject, under: /table Email Messages Listing/ } }],
        verify: async ({ snapshot }) => snapshot.includes(`Rs ${f.amount}`) && snapshot.includes(f.due)
      }
    },
    archive_sender: async ({ rng }) => {
      const box = readBox(ME.email)
      const senders = [...new Set(box.filter((m) => /: /.test(m.subject) && !colleague(m) && m.subject.startsWith(m.fromName)).map((m) => m.fromName))]
      const name = rng.pick(senders)
      if (!name) return null
      const ids = box.filter((m) => m.fromName === name).map((m) => m.id)
      return {
        goal: rng.pick([`Archive every email from ${name}.`, `Clean up my inbox: move all ${name} mails to the archive.`]),
        start: '/?_task=mail&_mbox=INBOX', answer: `Archived ${ids.length} emails from ${name}`,
        plan: [{ title: `Type ${name} in Search terms`, check: `textbox "Search terms" = ${name}` }, { title: 'Press Enter to search', check: `text "${name}"` }, { title: 'Click Select', check: 'the selection menu is shown' }, { title: 'Click All', check: 'all emails are selected' }, { title: 'Click Archive', check: `no email from ${name} in Inbox` }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Search terms' }, text: name },
          { plan: 2, do: 'press', key: 'Enter' },
          { plan: 3, do: 'click', target: { role: 'link', name: icon('Select') } },
          { plan: 4, do: 'click', target: { role: 'button', name: icon('All') } },
          { plan: 5, do: 'click', target: { role: 'button', name: icon('Archive') }, settle: 2500 }
        ],
        verify: async () => !readBox(ME.email).some((m) => m.fromName === name) && ids.every((id) => inFolder(FOLDERS.archive, id))
      }
    },
    open_folder_read: async ({ rng }) => {
      const [label, folder] = rng.pick([['Sent', FOLDERS.sent], ['Archive', FOLDERS.archive], ['Drafts', FOLDERS.drafts]])
      const m = readBox(ME.email, folder)[0]
      if (!m) return null
      return {
        goal: rng.pick([`What is the subject of the newest email in ${label}?`, `Open ${label} and tell me the subject of the latest mail there.`]),
        start: '/?_task=mail&_mbox=INBOX', answer: `The newest email in ${label} is "${m.subject}"`, writes: false,
        plan: [{ title: `Open the ${label} folder`, check: `url contains _mbox=${label}` }],
        steps: [{ plan: 1, do: 'click', target: { role: 'link', name: icon(label), under: /navigation Email folder selection/ } }],
        verify: async ({ snapshot }) => snapshot.includes(m.subject)
      }
    },
    add_contact: async ({ rng, sh }) => {
      const first = rng.pick(['Kiran', 'Rhea', 'Aman', 'Sofia', 'Jai', 'Mira', 'Ravi', 'Lina', 'Arnav', 'Eva'])
      const last = rng.pick(['Desai', 'Malhotra', 'Sen', 'Costa', 'Varma', 'Lopez', 'Bhat', 'Kim'])
      const email = `${first.toLowerCase()}.${last.toLowerCase()}@${rng.pick(['brightdesk.test', 'northwind.test', 'farm.test'])}`
      return {
        goal: rng.pick([`Add ${first} ${last} (${email}) to my contacts.`, `Save a new contact: ${first} ${last}, email ${email}.`]),
        start: '/?_task=mail&_mbox=INBOX', answer: `Added ${first} ${last} to contacts`,
        plan: [{ title: 'Click Contacts', check: 'url contains _task=addressbook' }, { title: 'Click Create', check: 'the new contact form is shown' }, { title: `Type ${first} in First Name`, check: `textbox "First Name" = ${first}` }, { title: `Type ${last} in Last Name`, check: `textbox "Last Name" = ${last}` }, { title: `Type ${email} in Email`, check: `textbox "Email" = ${email}` }, { title: 'Click Save', check: 'text "Successfully saved"' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: icon('Contacts') }, settle: 2000 },
          { plan: 2, do: 'click', target: { role: 'button', name: icon('Create') }, settle: 2000 },
          { plan: 3, do: 'type', target: { role: 'textbox', name: 'First Name' }, text: first },
          { plan: 4, do: 'type', target: { role: 'textbox', name: 'Last Name' }, text: last },
          { plan: 5, do: 'type', target: { role: 'textbox', name: 'Email' }, text: email },
          { plan: 6, do: 'click', target: { role: 'button', name: icon('Save') }, settle: 2000 }
        ],
        verify: async () => sh(`sqlite3 ${RC_DB} "select count(*) from contacts where email like '%${email}%' and del=0"`).trim() !== '0'
      }
    }
  }
}
