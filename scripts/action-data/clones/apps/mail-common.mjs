// Mail state and task content shared by the webmail clones (Roundcube, SnappyMail). The capture
// runs on the farm host, so it reads the live Maildirs directly to pick targets and verify results.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = '/dev/shm/clone-farm/mail'
export const ME = { name: 'Asha Rao', email: 'asha.rao@farm.test' }
export const FOLDERS = { inbox: '', sent: '.Sent', drafts: '.Drafts', trash: '.Trash', archive: '.Archive', junk: '.Junk', travel: '.Travel', receipts: '.Receipts', projects: '.Projects' }
export const PEOPLE = JSON.parse(readFileSync('/workspace/clone-farm/snap/mail-people.json', 'utf8')).people

function headers(raw) {
  const head = raw.split(/\r?\n\r?\n/)[0].replace(/\r?\n[ \t]+/g, ' ')
  const h = {}
  for (const line of head.split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) h[line.slice(0, i).toLowerCase()] ??= line.slice(i + 1).trim() }
  return h
}

/** Messages in a folder of a mailbox, newest first. */
export function readBox(email, folder = '') {
  const [user, domain] = email.split('@')
  const dir = join(ROOT, domain, user, 'Maildir', folder)
  const out = []
  for (const sub of ['new', 'cur']) {
    const d = join(dir, sub)
    if (!existsSync(d)) continue
    for (const file of readdirSync(d)) {
      const raw = readFileSync(join(d, file), 'utf8')
      const h = headers(raw)
      const flags = (file.split(':2,')[1] ?? '')
      const from = h.from ?? ''
      const m = from.match(/^"?(.*?)"?\s*<(.+)>$/)
      out.push({ file, sub, flags, seen: flags.includes('S'), flagged: flags.includes('F'), id: h['message-id'], subject: h.subject ?? '', fromName: m ? m[1] : from, fromEmail: m ? m[2] : from, to: h.to ?? '', date: new Date(h.date), body: raw.split(/\r?\n\r?\n/).slice(1).join('\n\n').replace(/=\r?\n/g, '').replace(/\r?\n/g, ' ') })
    }
  }
  return out.sort((a, b) => b.date - a.date)
}

export const inFolder = (folder, id, email = ME.email) => readBox(email, folder).some((m) => m.id === id)
/** A message that reached `email` after `since` (ms) and passes `test`: sent during this episode. */
export const received = (email, test, since = 0) => readBox(email, '').some((m) => m.date.getTime() >= since - 5000 && test(m))

export const COMPOSE = [
  ['Lunch on Friday?', 'Are you free for lunch on Friday at 1 pm? There is a new South Indian place near the office.'],
  ['Q4 budget numbers', 'Please send me the final Q4 budget numbers by Wednesday so I can add them to the deck.'],
  ['Team offsite venue', 'I shortlisted two venues for the offsite in Goa. Can we decide by Monday?'],
  ['Laptop return', 'My old laptop is ready to return. When can IT collect it?'],
  ['Interview feedback', 'Thanks for joining the interview today. Please add your feedback to the hiring sheet.'],
  ['Invoice query', 'The last invoice shows two charges for the same month. Can you check it?'],
  ['Design review moved', 'The design review is moved to Thursday 4 pm. Same room.'],
  ['Welcome to the team', 'Welcome aboard! Let me know if you need help with anything in your first week.'],
  ['Train tickets', 'I booked the train tickets to Pune for the 24th. Details are attached in the travel folder.'],
  ['Weekly report', 'Here is a short summary of this week: launch on track, two bugs open, hiring on hold.'],
  ['Customer call notes', 'The customer asked for an SSO option and a monthly invoice. I will share the notes.'],
  ['Parking passes', 'The new parking passes are ready at the front desk.'],
  ['Server maintenance', 'The staging server will be down on Saturday from 10 am to noon.'],
  ['Book club', 'The next book club pick is "The Overstory". We meet on the 30th.'],
  ['Expense claim', 'I submitted the expense claim for the client dinner. Please approve it when you can.']
]
export const REPLIES = ['Thanks, noted.', 'Sounds good to me.', 'Sure, I will send it by end of day.', 'Thanks! Let us discuss this tomorrow.', 'Got it, I will take care of it.', 'Can we move this to next week?', 'Yes, that works for me.', 'Thanks for the update.', 'I will check and get back to you today.']

/** Seeded invoice facts, from the message body. */
export function invoiceFacts(m) {
  const num = (m.subject.match(/INV-\d+/) ?? [])[0]
  const amount = (m.body.match(/Rs ([\d,]+)/) ?? [])[1]
  const due = (m.body.match(/Due date: ([^.\n]+)/) ?? [])[1]
  const paid = /has been paid/.test(m.body)
  return { num, amount, due, paid }
}
