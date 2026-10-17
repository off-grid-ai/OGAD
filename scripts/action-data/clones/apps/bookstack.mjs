// BookStack on wiki.farm.test (PHP + private MariaDB on 7152): a Confluence/Notion-like company wiki.
// Seed: seed/wiki_seed.php (25 users, 4 shelves, 12 books, 309 pages with a "Key facts" list, tags, comments).
// The user is asha.rao@farm.test (Editor). Reset: farm/wiki/reset.sh (datadir rsync, ~1 s).
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
const ORIGIN = 'http://wiki.farm.test'
const USER = 'asha.rao@farm.test'

const sql = (sh, q) => sh('mysql --socket=/run/mysqld/wiki.sock bookstack -N -B', { input: q, stdio: ['pipe', 'pipe', 'pipe'] })
  .trim().split('\n').filter(Boolean).map((l) => l.split('\t'))
const lit = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Search results split a title into <strong> words: match it with any spacing.
const loose = (s) => [...s.replace(/\s+/g, '')].map(esc).join('\\s*')
const decode = (s) => s.replace(/&#039;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')

let PAGES = null
/** Every page with its book (slug, name), url, and Key facts. Pages never change identity, so cache. */
function pages(sh) {
  if (PAGES) return PAGES
  PAGES = sql(sh, `SELECT p.id, p.name, p.slug, b.id, b.name, b.slug, IFNULL((SELECT c.slug FROM entities c WHERE c.id=p.chapter_id AND c.type='chapter'), ''), REPLACE(REPLACE(d.html, '\\n', ' '), '\\t', ' ') FROM entities p JOIN entities b ON b.id=p.book_id AND b.type='book' JOIN entity_page_data d ON d.page_id=p.id WHERE p.type='page' AND p.deleted_at IS NULL AND d.draft=0`)
    .map(([id, name, slug, bookId, book, bookSlug, chapterSlug, html]) => ({
      id: Number(id), name: decode(name), slug, bookId: Number(bookId), book: decode(book), bookSlug, url: `/books/${bookSlug}/page/${slug}`,
      parentUrl: chapterSlug ? `/books/${bookSlug}/chapter/${chapterSlug}` : `/books/${bookSlug}`,
      facts: [...html.matchAll(/<li[^>]*><strong>([^<:]+):<\/strong>\s*([^<]+)<\/li>/g)].map((m) => [m[1], decode(m[2]).trim()]),
      notes: decode((html.match(/<h2[^>]*>Notes<\/h2>\s*<p[^>]*>([^<]+)<\/p>/) ?? [])[1] ?? '')
    }))
  return PAGES
}
const books = (sh) => [...new Map(pages(sh).map((p) => [p.bookId, { id: p.bookId, name: p.book, slug: p.bookSlug }])).values()]
const pageHtml = (sh, id) => sql(sh, `SELECT REPLACE(html, '\\n', ' ') FROM entity_page_data WHERE page_id=${id}`)[0]?.[0] ?? ''
const unique = (sh, p) => pages(sh).filter((x) => x.name === p.name).length === 1

const ASK = {
  Owner: ['Who owns the "%s" page?', 'Who is the owner of %s?'],
  Team: ['Which team is responsible for %s?'],
  'Last reviewed': ['When was the %s page last reviewed?'],
  'Review cycle': ['How often is %s reviewed?'],
  'Applies to': ['Who does the %s apply to?'],
  Escalation: ['Where do I escalate for "%s"?'],
  Dashboard: ['Which dashboard does the "%s" runbook use?'],
  'Time to resolve': ['What is the expected time to resolve for "%s"?'],
  Limit: ['What is the limit in the %s?', 'What is the spending limit mentioned in %s?'],
  'Days per year': ['How many days per year does the %s give?'],
  Location: ['Which location does "%s" cover?'],
  Contact: ['Who is the contact for "%s"?'],
  Approver: ['Who approves things under "%s"?'],
  Tool: ['Which tool is used for %s?']
}

const tasks = {
  // Search the wiki and read a fact from a page.
  search_fact: async ({ rng, sh }) => {
    const p = rng.pick(pages(sh).filter((x) => unique(sh, x) && x.facts.length && !/[?]/.test(x.name)))
    const [label, value] = rng.pick(p.facts)
    const goal = rng.pick(ASK[label] ?? ['What does %s say about ' + label.toLowerCase() + '?']).replace('%s', p.name)
    return {
      goal: rng.chance(0.3) ? `Search the wiki: ${goal}` : goal,
      start: '/',
      plan: [
        { title: `Search for ${p.name}`, check: 'heading "Search Results"' },
        { title: `Open the page ${p.name}`, check: `heading "${p.name}"` }
      ],
      steps: [
        { plan: 1, do: 'type', target: { role: 'textbox', name: 'Search', under: /^search/ }, text: p.name },
        { plan: 1, do: 'press', key: 'Enter', settle: 2000 },
        { plan: 2, do: 'click', target: { role: 'link', text: new RegExp(`^${loose(p.name)}\\s${loose(p.book)}\\s`) }, settle: 1800 }
      ],
      answer: `${label}: ${value}.`,
      verify: async ({ snapshot }) => snapshot.includes(value) && pageHtml(sh, p.id).includes(`<strong>${label}:</strong>`),
      writes: false
    }
  },

  // Browse a book and read a fact.
  browse_fact: async ({ rng, sh }) => {
    const p = rng.pick(pages(sh).filter((x) => x.facts.length))
    const [label, value] = rng.pick(p.facts)
    return {
      goal: rng.pick(ASK[label] ?? ['What does %s say?']).replace('%s', p.name) + ` It is in the ${p.book} book.`,
      start: p.parentUrl,
      plan: [{ title: `Open ${p.name} in ${p.book}`, check: `heading "${p.name}"` }],
      steps: [{ plan: 1, do: 'click', target: { role: 'link', text: new RegExp(`^${loose(p.name)}(\\s|$)`), under: /^main/ }, settle: 1800 }],
      answer: `${label}: ${value}.`,
      verify: async ({ snapshot }) => snapshot.includes(value),
      writes: false
    }
  },

  create_page: async ({ rng, sh }) => {
    const b = rng.pick(books(sh))
    const topic = rng.pick(['Team Offsite Plan', 'Quarterly Goals', 'Vendor Contacts', 'Meeting Notes', 'Incident Review', 'Hackathon Rules', 'Desk Moves', 'Budget Notes', 'Launch Checklist', 'Holiday Rota'])
    const title = `${topic} ${rng.pick(['Q4', 'Q1', 'October', 'November', 'Pune', 'Bengaluru', '2027'])} ${rng.int(2, 99)}`
    const text = rng.pick(['Draft owner: Asha Rao. Please add your notes below.', 'This page tracks decisions and next steps.', 'Agenda, attendees and action items go here.', 'First draft, to be reviewed on Friday.']) + ` Ref ${rng.int(100, 999)}.`
    return {
      goal: rng.pick([`Create a page "${title}" in the ${b.name} book with the text: ${text}`, `In ${b.name}, add a new page titled "${title}". Content: "${text}"`, `Write a new wiki page "${title}" under ${b.name} saying: ${text}`]),
      start: `/books/${b.slug}`,
      plan: [
        { title: 'Start a new page', check: 'textbox "Page Title"' },
        { title: `Enter the title "${title}"`, check: `textbox "Page Title" = ${title}` },
        { title: 'Write the content', check: `text "${text}"` },
        { title: 'Save the page', check: `heading "${title}"` }
      ],
      steps: [
        { plan: 1, do: 'click', target: { role: 'link', name: 'New Page' }, settle: 3000 },
        { plan: 2, do: 'type', target: { role: 'textbox', name: 'Page Title' }, text: title },
        { plan: 3, do: 'click', target: { role: 'paragraph', under: /^iframe/ }, mayNotChange: true },
        { plan: 3, do: 'type', target: { role: 'paragraph', under: /^iframe/ }, text },
        { plan: 4, do: 'click', target: { role: 'button', name: 'Save Page' }, settle: 2500 }
      ],
      answer: `Created the page "${title}" in ${b.name}.`,
      verify: async () => {
        const r = sql(sh, `SELECT p.book_id, d.html FROM entities p JOIN entity_page_data d ON d.page_id=p.id WHERE p.type='page' AND p.name=${lit(title)} AND d.draft=0`)
        return r.length === 1 && Number(r[0][0]) === b.id && r[0][1].includes(text)
      }
    }
  },

  // Edit one section (the Notes paragraph) of a page.
  edit_section: async ({ rng, sh }) => {
    const p = rng.pick(pages(sh).filter((x) => x.notes))
    const text = rng.pick(['Questions go to the #help channel; the owner replies within one working day.', 'Updated for 2027: exceptions now need approval from the team lead.', 'Keep a copy of every approval in the shared drive.', 'From November, requests go through the new service desk.']) + ` (${rng.int(10, 99)})`
    const viaPage = rng.chance(0.5)
    return {
      goal: rng.pick([`In the page "${p.name}", replace the Notes section text with: ${text}`, `Update the Notes of ${p.name} to say "${text}"`, `Edit "${p.name}": the note under Notes should read: ${text}`]),
      start: viaPage ? p.url : `${p.url}/edit`,
      startWait: 2500,
      plan: [
        ...(viaPage ? [{ title: 'Open the editor', check: 'button "Save Page"' }] : []),
        { title: 'Replace the Notes paragraph', check: `text "${text}"` },
        { title: 'Save the page', check: `heading "${p.name}"` }
      ],
      steps: [
        ...(viaPage ? [{ plan: 1, do: 'click', target: { role: 'link', name: 'Edit', under: /^complementary/ }, settle: 3000 }] : []),
        { plan: viaPage ? 2 : 1, do: 'type', target: { role: 'paragraph', value: p.notes, under: /^iframe/ }, text },
        { plan: viaPage ? 3 : 2, do: 'click', target: { role: 'button', name: 'Save Page' }, settle: 2500 }
      ],
      answer: `Updated the Notes of "${p.name}".`,
      verify: async () => { const h = decode(pageHtml(sh, p.id)); return h.includes(text) && !h.includes(p.notes) }
    }
  },

  add_tag: async ({ rng, sh }) => {
    const p = rng.pick(pages(sh))
    const tag = rng.pick(['needs-review', 'outdated', 'important', 'draft', 'faq', 'legal', 'q4', 'onboarding', 'finance', 'security'])
    const value = rng.chance(0.3) ? rng.pick(['2026', 'high', 'yes', 'v2']) : ''
    if (sql(sh, `SELECT 1 FROM tags WHERE entity_id=${p.id} AND entity_type='page' AND name=${lit(tag)}`).length) return null
    return {
      goal: value ? `Add the tag "${tag}" with value "${value}" to the page ${p.name}.` : rng.pick([`Tag the page "${p.name}" with "${tag}".`, `Add a "${tag}" tag to ${p.name}.`]),
      start: `${p.url}/edit`,
      startWait: 2500,
      plan: [
        { title: 'Open the tags panel', check: 'textbox "Tag Name"' },
        { title: `Enter the tag ${tag}`, check: `textbox "Tag Name" = ${tag}` },
        { title: 'Save the page', check: `text "${tag}"` }
      ],
      steps: [
        { plan: 1, do: 'click', target: { role: 'button', name: 'Page Tags' } },
        { plan: 2, do: 'type', target: { role: 'textbox', name: 'Tag Name' }, text: tag },
        ...(value ? [{ plan: 2, do: 'type', target: { role: 'textbox', name: 'Tag Value (Optional)' }, text: value }] : []),
        { plan: 3, do: 'click', target: { role: 'button', name: 'Save Page' }, settle: 2500 }
      ],
      answer: `Tagged "${p.name}" with ${tag}${value ? `: ${value}` : ''}.`,
      verify: async () => sql(sh, `SELECT value FROM tags WHERE entity_id=${p.id} AND entity_type='page' AND name=${lit(tag)}`)[0]?.[0] === value || (value === '' && sql(sh, `SELECT COUNT(*) FROM tags WHERE entity_id=${p.id} AND entity_type='page' AND name=${lit(tag)}`)[0][0] === '1')
    }
  },

  move_page: async ({ rng, sh }) => {
    const p = rng.pick(pages(sh))
    const b = rng.pick(books(sh).filter((x) => x.id !== p.bookId))
    const viaPage = rng.chance(0.5)
    return {
      goal: rng.pick([`Move the page "${p.name}" to the ${b.name} book.`, `"${p.name}" belongs in ${b.name}; move it there.`]),
      start: viaPage ? p.url : `${p.url}/move`,
      startWait: 2500,
      plan: [
        ...(viaPage ? [{ title: 'Open Move', check: 'heading "Move Page"' }] : []),
        { title: `Choose the ${b.name} book`, check: `link ${b.name} is selected` },
        { title: 'Move the page', check: `link "${b.name}" in the breadcrumb` }
      ],
      steps: [
        ...(viaPage ? [{ plan: 1, do: 'click', target: { role: 'link', name: 'Move', under: /^complementary/ }, settle: 3000 }] : []),
        { plan: viaPage ? 2 : 1, do: 'click', target: { role: 'link', text: new RegExp(`^${esc(b.name)} ${esc(b.name)} for Northwind`), under: /^main/ } },
        { plan: viaPage ? 3 : 2, do: 'click', target: { role: 'button', name: 'Move Page' }, settle: 2500 }
      ],
      answer: `Moved "${p.name}" to ${b.name}.`,
      verify: async () => Number(sql(sh, `SELECT book_id FROM entities WHERE id=${p.id} AND type='page'`)[0]?.[0]) === b.id
    }
  },

  comment: async ({ rng, sh }) => {
    const p = rng.pick(pages(sh))
    const text = rng.pick(['Thanks, this answered my question.', 'Can someone confirm this is still current?', 'I followed these steps today and they worked.', 'Please add a section about exceptions.', 'The owner field looks outdated.']) + ` (${rng.int(10, 99)})`
    return {
      goal: rng.pick([`Leave a comment on "${p.name}": ${text}`, `Comment on the ${p.name} page saying "${text}"`]),
      start: p.url,
      plan: [
        { title: 'Start a new comment', check: 'button "Save Comment"' },
        { title: 'Write the comment', check: `text "${text}"` },
        { title: 'Save it', check: 'tab "1 Comment Thread" or more' }
      ],
      steps: [
        { plan: 1, do: 'click', target: { role: 'button', name: 'Add Comment' } },
        { plan: 2, do: 'type', target: { role: 'paragraph', inside: /^New Comment/, insideDepth: 6 }, text },
        { plan: 3, do: 'click', target: { role: 'button', name: 'Save Comment' }, settle: 2500 }
      ],
      answer: `Commented on "${p.name}".`,
      verify: async () => sql(sh, `SELECT 1 FROM comments c JOIN users u ON u.id=c.created_by WHERE c.commentable_id=${p.id} AND u.email='${USER}' AND c.html LIKE ${lit(`%${text.replace(/[%_]/g, '')}%`)}`).length === 1
    }
  },

  rename_page: async ({ rng, sh }) => {
    const p = rng.pick(pages(sh).filter((x) => x.name.length < 60))
    const name = `${p.name} (${rng.pick(['2027', 'v2', 'Updated', 'Draft', 'Old'])})`
    return {
      goal: rng.pick([`Rename the page "${p.name}" to "${name}".`, `Change the title of ${p.name} to ${name}.`]),
      start: `${p.url}/edit`,
      startWait: 2500,
      plan: [
        { title: 'Change the title', check: `textbox "Page Title" = ${name}` },
        { title: 'Save the page', check: `heading "${name}"` }
      ],
      steps: [
        { plan: 1, do: 'type', target: { role: 'textbox', name: 'Page Title' }, text: name },
        { plan: 2, do: 'click', target: { role: 'button', name: 'Save Page' }, settle: 2500 }
      ],
      answer: `Renamed to "${name}".`,
      verify: async () => decode(sql(sh, `SELECT name FROM entities WHERE id=${p.id} AND type='page'`)[0]?.[0] ?? '') === name
    }
  },

  favourite_page: async ({ rng, sh }) => {
    const p = rng.pick(pages(sh))
    return {
      goal: rng.pick([`Add the page "${p.name}" to my favourites.`, `Favourite the ${p.name} page so I can find it later.`]),
      start: p.url,
      plan: [{ title: 'Click Favourite', check: 'button "Unfavourite"' }],
      steps: [{ plan: 1, do: 'click', target: { role: 'button', name: 'Favourite' }, settle: 2000 }],
      answer: `"${p.name}" is in your favourites.`,
      verify: async () => sql(sh, `SELECT 1 FROM favourites f JOIN users u ON u.id=f.user_id WHERE f.favouritable_id=${p.id} AND u.email='${USER}'`).length === 1
    }
  },

  create_chapter: async ({ rng, sh }) => {
    const b = rng.pick(books(sh))
    const name = `${rng.pick(['Archive', 'Templates', 'FAQs', 'Checklists', 'Contacts', 'Decisions', 'Reference'])} ${rng.pick(['2026', '2027', 'Q4', 'India', 'Team'])} ${rng.int(2, 99)}`
    return {
      goal: rng.pick([`Create a chapter called "${name}" in the ${b.name} book.`, `Add a new chapter "${name}" to ${b.name}.`]),
      start: `/books/${b.slug}`,
      plan: [
        { title: 'Start a new chapter', check: 'textbox "Name"' },
        { title: `Name it ${name}`, check: `textbox "Name" = ${name}` },
        { title: 'Save the chapter', check: `heading "${name}"` }
      ],
      steps: [
        { plan: 1, do: 'click', target: { role: 'link', name: 'New Chapter' }, settle: 2000 },
        { plan: 2, do: 'type', target: { role: 'textbox', name: 'Name' }, text: name },
        { plan: 3, do: 'click', target: { role: 'button', name: 'Save Chapter' }, settle: 2500 }
      ],
      answer: `Created the chapter "${name}" in ${b.name}.`,
      verify: async () => Number(sql(sh, `SELECT book_id FROM entities WHERE type='chapter' AND name=${lit(name)}`)[0]?.[0]) === b.id
    }
  }
}

export default {
  name: 'bookstack',
  family: 'wiki',
  origin: ORIGIN,
  portOffset: 52,
  explorePaths: ['/', '/shelves', '/books', '/books/policies', '/books/runbooks'],
  async reset({ sh }) { sh('bash /workspace/action-data-gen/scripts/clones/farm/wiki/reset.sh') },
  async login({ page, sleep }) {
    await page.context().clearCookies()
    await page.goto(`${ORIGIN}/login`)
    await page.fill('#email', USER)
    await page.fill('#password', ACCOUNTS.password)
    await page.press('#password', 'Enter')
    await page.waitForURL((u) => !/login/.test(u.pathname), { timeout: 30_000 })
    await sleep(500)
  },
  tasks
}
