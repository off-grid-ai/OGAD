// Etherpad 3 (+ ep_headings2) on docs.farm.test: a Google-Docs-like editor whose lines are real DOM
// (headings, paragraphs, list items inside the editor iframes). Seed: seed/etherpad_seed.py (67 pads: meeting notes,
// proposals, specs, offsite plans; facts in /workspace/clone-farm/snap/etherpad/facts.json).
// Text is typed key by key (`slowly: true`): Playwright fill() does not reach Etherpad's editor model.
// State is read with Etherpad's HTTP API (getText / getHTML).
import { readFileSync } from 'node:fs'

const API = 'http://127.0.0.1:7132/api/1.3.0'
const KEY = () => readFileSync('/workspace/clone-farm/etherpad/APIKEY.txt', 'utf8').trim()
let FACTS = null
const facts = () => (FACTS ??= JSON.parse(readFileSync('/workspace/clone-farm/snap/etherpad/facts.json', 'utf8')))
const api = (sh, fn, params) => {
  const q = Object.entries({ apikey: KEY(), ...params }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  try { return JSON.parse(sh(`curl -sf '${API}/${fn}?${q}'`)) } catch { return {} }
}
const getText = (sh, padID) => api(sh, 'getText', { padID }).data?.text ?? ''
const getHTML = (sh, padID) => api(sh, 'getHTML', { padID }).data?.html ?? ''
// &amp; last, so an escaped entity is read once.
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
const untag = (s) => { let t = s; let p; do { p = t; t = t.replace(/<[^>]+>/g, '') } while (t !== p); return t }
const strip = (s) => decode(untag(s)).replace(/\s+/g, ' ').trim()
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** RegExp for a line's whole text (the snapshot splits bold runs into separate nodes). */
const lineRe = (text) => new RegExp(`^${text.split(/\s+/).map(esc).join('\\s*')}$`)

/** Lines of a seed pad: { kind: heading|paragraph|item, level, text, list } in order. */
function lines(pid) {
  const html = facts()[pid].html.replace(/^.*?<body>|<\/body>.*$/gs, '')
  const out = []
  let list = 0
  for (const tok of html.split(/(<h[1-4]>.*?<\/h[1-4]>|<ul[^>]*>.*?<\/ul>|<br>)/s)) {
    if (!tok || tok === '<br>') continue
    const h = tok.match(/^<h([1-4])>(.*?)<\/h\1>$/s)
    if (h) { out.push({ kind: 'heading', level: Number(h[1]), text: strip(h[2]) }); continue }
    if (tok.startsWith('<ul')) { list++; for (const li of tok.split(/<li>/).slice(1)) out.push({ kind: 'item', text: strip(li), list }); continue }
    const t = strip(tok)
    if (t) out.push({ kind: 'paragraph', text: t, bold: /<strong>/.test(tok) })
  }
  return out
}
const pads = (kind) => Object.keys(facts()).filter((p) => !kind || facts()[p].kind === kind)
const target = (l) => (l.kind === 'heading' ? { role: 'heading', name: l.text } : l.kind === 'item' ? { role: 'listitem', text: lineRe(l.text) } : { role: 'paragraph', text: lineRe(l.text) })
// Typing goes to the editor root at the caret (key by key): typing into a line element moves focus and loses the caret.
const DOC = { role: 'generic', name: 'Pad content' }
// The ep_headings2 style dropdown: its text starts with the current style, then the options.
const STYLE = { role: 'generic', text: /^(Style|Normal|Heading [1-4]|Code) Normal Heading 1 Heading 2/ }
const lastEmpty = { role: 'paragraph', text: /^$/, nth: 999 }
const SEL = [{ do: 'press', key: 'Home', mayNotChange: true, settle: 300 }, { do: 'press', key: 'Shift+End', mayNotChange: true, settle: 300 }]
const unique = (pid, l) => lines(pid).filter((x) => x.text === l.text).length === 1

const SENTENCES = ['We will review progress again next week.', 'Budget approval is still pending from finance.', 'The vendor confirmed the new timeline by email.',
  'Customer feedback so far has been positive.', 'We need one more designer for this work.', 'Legal has signed off on the data terms.',
  'The pilot will start with two regional teams.', 'Please add comments before Thursday.', 'Risks are tracked in the shared sheet.']
const BULLETS = ['Confirm the scope with the owner', 'Share the draft with the team', 'Book the review meeting', 'Update the roadmap', 'Collect cost estimates',
  'Write the launch note', 'Check data retention rules', 'Plan the rollout', 'Send the summary to leadership', 'Set up a feature flag']
const HEADS = ['Next steps', 'Follow-ups', 'Open items', 'Summary', 'Decisions', 'Timeline', 'Owners']

const tasks = {
  // D6-style: replace text in a line (select the line, type the new text).
  replace_text: async ({ rng }) => {
    const pid = rng.pick(pads())
    const cand = lines(pid).filter((l) => l.kind !== 'heading' && l.text.length <= 80 && /\b(Q3|Q4|\d{2,}|Friday|Draft)\b/.test(l.text) && unique(pid, l))
    if (!cand.length) return null
    const l = rng.pick(cand)
    let next
    if (/\bQ3\b/.test(l.text)) next = l.text.replace(/\bQ3\b/g, 'Q4')
    else if (/\bQ4\b/.test(l.text)) next = l.text.replace(/\bQ4\b/g, 'Q1')
    else if (/\bFriday\b/.test(l.text)) next = l.text.replace('Friday', rng.pick(['Monday', 'Wednesday', 'Thursday']))
    else if (/\bDraft\b/.test(l.text)) next = l.text.replace('Draft', 'Approved')
    else { const n = l.text.match(/\d{2,}/)[0]; next = l.text.replace(n, String(Number(n) + rng.int(1, 9) * (n.length > 3 ? 1000 : 1))) }
    const [a, b] = [l.text.match(/\bQ3\b|\bQ4\b|Friday|Draft|\d{2,}/)[0], next.match(/\bQ4\b|\bQ1\b|Monday|Wednesday|Thursday|Approved|\d{2,}/)[0]]
    return {
      goal: rng.pick([`In the doc ${pid}, change "${a}" to "${b}" in the line "${l.text}".`, `Edit ${facts()[pid].title}: the line "${l.text}" should read "${next}".`,
        `Replace ${a} with ${b} in this line of ${pid}: "${l.text}".`]),
      start: `/p/${pid}`, startWait: 3000,
      plan: [{ title: `Select the line "${l.text}"`, check: 'the line is selected' }, { title: `Type "${next}"`, check: `text "${next}"` }],
      steps: [{ plan: 1, do: 'click', target: target(l), mayNotChange: true, settle: 500 }, ...SEL.map((s) => ({ ...s, plan: 1 })),
        { plan: 2, do: 'type', target: DOC, text: next, slowly: true, settle: 2000 }],
      answer: `The line now reads "${next}".`,
      verify: async ({ sh }) => { const t = getText(sh, pid); return t.includes(next) && !t.split('\n').some((x) => x.replace(/^\*/, '') === l.text) }
    }
  },

  // Append a paragraph at the end of a doc.
  append_paragraph: async ({ rng }) => {
    const pid = rng.pick(pads())
    const s = rng.pick(SENTENCES)
    return {
      goal: rng.pick([`Add the sentence "${s}" at the end of ${pid}.`, `Append a paragraph to ${facts()[pid].title}: "${s}"`, `At the bottom of the doc ${pid}, write: ${s}`]),
      start: `/p/${pid}`, startWait: 3000,
      plan: [{ title: 'Click the empty last line', check: 'the cursor is at the end of the doc' }, { title: `Type the sentence`, check: `text "${s}"` }],
      steps: [{ plan: 1, do: 'click', target: lastEmpty, mayNotChange: true, settle: 500 }, { plan: 2, do: 'type', target: DOC, text: s, slowly: true, settle: 2000 }],
      answer: `Added "${s}" at the end.`,
      verify: async ({ sh }) => getText(sh, pid).trimEnd().endsWith(s)
    }
  },

  // D7: a heading and three bullets at the end.
  heading_bullets: async ({ rng }) => {
    const pid = rng.pick(pads())
    const head = rng.pick(HEADS)
    if (lines(pid).some((l) => l.text === head)) return null
    const items = rng.sample(BULLETS, 3)
    return {
      goal: rng.pick([`At the end of ${pid}, add a heading "${head}" and three bullet points: ${items.join('; ')}.`,
        `Add a "${head}" section (Heading 2) to ${facts()[pid].title} with the bullets ${items.map((x) => `"${x}"`).join(', ')}.`]),
      start: `/p/${pid}`, startWait: 3000,
      plan: [{ title: `Type "${head}" on the last line`, check: `text "${head}"` }, { title: 'Make it Heading 2', check: `heading "${head}"` },
        { title: 'Start a bullet list below it', check: 'an empty bullet' }, { title: 'Type the three bullets', check: `text "${items[2]}"` }],
      steps: [
        { plan: 1, do: 'click', target: lastEmpty, mayNotChange: true, settle: 500 },
        { plan: 1, do: 'type', target: DOC, text: head, slowly: true, settle: 1500 },
        { plan: 2, do: 'click', target: STYLE, mayNotChange: true },
        { plan: 2, do: 'click', target: { role: 'listitem', text: /^Heading 2$/ }, settle: 1500 },
        { plan: 3, do: 'press', key: 'End', mayNotChange: true, settle: 300 },
        { plan: 3, do: 'press', key: 'Enter', settle: 1000 },
        { plan: 3, do: 'click', target: { role: 'button', name: /^Unordered List/ }, settle: 1000 },
        { plan: 4, do: 'type', target: DOC, text: items[0], slowly: true, settle: 800 },
        { plan: 4, do: 'press', key: 'Enter', settle: 800 },
        { plan: 4, do: 'type', target: DOC, text: items[1], slowly: true, settle: 800 },
        { plan: 4, do: 'press', key: 'Enter', settle: 800 },
        { plan: 4, do: 'type', target: DOC, text: items[2], slowly: true, settle: 2000 }
      ],
      answer: `Added "${head}" with ${items.length} bullets.`,
      verify: async ({ sh }) => { const h = getHTML(sh, pid); return new RegExp(`<h2>${esc(head)}</h2>`).test(h) && items.every((x) => h.includes(`<li>${x}`)) }
    }
  },

  // D12-style: make a line bold.
  make_bold: async ({ rng }) => {
    const pid = rng.pick(pads())
    // Home / Shift+End select one visual line: keep to lines that do not wrap.
    const cand = lines(pid).filter((l) => l.kind === 'paragraph' && !l.bold && l.text.length <= 80 && unique(pid, l))
    if (!cand.length) return null
    const l = rng.pick(cand)
    return {
      goal: rng.pick([`Make the sentence "${l.text}" bold in ${pid}.`, `In ${facts()[pid].title}, bold the line "${l.text}".`]),
      start: `/p/${pid}`, startWait: 3000,
      plan: [{ title: `Select the line "${l.text}"`, check: 'the line is selected' }, { title: 'Click Bold', check: 'the line is bold' }],
      steps: [{ plan: 1, do: 'click', target: target(l), mayNotChange: true, settle: 500 }, ...SEL.map((s) => ({ ...s, plan: 1 })),
        { plan: 2, do: 'click', target: { role: 'button', name: /^Bold/ }, settle: 2000 }],
      answer: `"${l.text}" is bold now.`,
      verify: async ({ sh }) => getHTML(sh, pid).includes(`<strong>${l.text.replace(/&/g, '&amp;')}</strong>`)
    }
  },

  // Turn a paragraph line into a heading.
  make_heading: async ({ rng }) => {
    const pid = rng.pick(pads())
    const cand = lines(pid).filter((l) => l.kind === 'paragraph' && !l.bold && l.text.length < 90 && unique(pid, l))
    if (!cand.length) return null
    const l = rng.pick(cand)
    const level = rng.pick([2, 3])
    return {
      goal: rng.pick([`In ${pid}, turn the line "${l.text}" into a Heading ${level}.`, `Make "${l.text}" a level ${level} heading in ${facts()[pid].title}.`]),
      start: `/p/${pid}`, startWait: 3000,
      plan: [{ title: `Put the cursor in the line "${l.text}"`, check: 'the cursor is in the line' }, { title: `Choose Heading ${level} in the Style menu`, check: `heading "${l.text}"` }],
      steps: [{ plan: 1, do: 'click', target: target(l), mayNotChange: true, settle: 500 },
        { plan: 2, do: 'click', target: STYLE, mayNotChange: true },
        { plan: 2, do: 'click', target: { role: 'listitem', text: new RegExp(`^Heading ${level}$`) }, settle: 2000 }],
      answer: `"${l.text}" is a Heading ${level} now.`,
      verify: async ({ sh }) => getHTML(sh, pid).includes(`<h${level}>${l.text.replace(/&/g, '&amp;')}</h${level}>`)
    }
  },

  // Add one more bullet to a list (after its last item).
  add_bullet: async ({ rng }) => {
    const pid = rng.pick(pads())
    const ls = lines(pid)
    const items = ls.filter((l) => l.kind === 'item')
    if (!items.length) return null
    const listNo = rng.pick([...new Set(items.map((l) => l.list))])
    const last = items.filter((l) => l.list === listNo).at(-1)
    if (!unique(pid, last)) return null
    const heading = ls.slice(0, ls.indexOf(last)).filter((l) => l.kind === 'heading').at(-1)?.text ?? 'the list'
    const text = rng.pick(BULLETS.filter((b) => !items.some((i) => i.text === b)))
    return {
      goal: rng.pick([`Add "${text}" as a new bullet under ${heading} in ${pid}.`, `In ${facts()[pid].title}, add the bullet "${text}" to the ${heading} list.`]),
      start: `/p/${pid}`, startWait: 3000,
      plan: [{ title: `Put the cursor at the end of "${last.text}"`, check: 'the cursor is at the end of the last bullet' }, { title: 'Press Enter and type the new bullet', check: `text "${text}"` }],
      steps: [{ plan: 1, do: 'click', target: target(last), mayNotChange: true, settle: 500 }, { plan: 1, do: 'press', key: 'End', mayNotChange: true, settle: 300 },
        { plan: 2, do: 'press', key: 'Enter', settle: 1000 }, { plan: 2, do: 'type', target: DOC, text, slowly: true, settle: 2000 }],
      answer: `Added the bullet "${text}".`,
      verify: async ({ sh }) => { const h = getHTML(sh, pid); return h.includes(`<li>${last.text.replace(/&/g, '&amp;')}</li><li>${text}`) || h.includes(`<li>${last.text.replace(/&/g, '&amp;')}<li>${text}`) }
    }
  },

  // Read a fact from a doc.
  read_fact: async ({ rng }) => {
    const pid = rng.pick(pads())
    const f = facts()[pid]
    const ls = lines(pid)
    const find = (re) => ls.find((l) => re.test(l.text))
    let goal; let answer; let l
    if (f.kind === 'meeting') {
      l = find(/^Ship|^Pause|^Move|^Hire/); goal = rng.pick([`What did the ${f.team} team decide in the sync on ${f.date}?`, `Read ${pid} and tell me the decision.`]); answer = f.decision
    } else if (f.kind === 'proposal') {
      l = find(/^Total cost/); goal = rng.pick([`How much does the proposal "${f.title}" cost?`, `What is the total cost in ${pid}?`]); answer = `Rs ${f.cost.toLocaleString('en-US')}`
    } else if (f.kind === 'spec') {
      l = find(/must answer in under/); goal = rng.pick([`What latency does the ${f.title} require?`, `In ${pid}, what is the 95th percentile latency target?`]); answer = `${f.latency} ms`
    } else {
      l = find(/^Date:/); goal = rng.pick([`What is the budget for the ${f.title}?`, `How many people go to the ${f.title}, and what is the budget?`]); answer = `${f.people} people, Rs ${f.budget.toLocaleString('en-US')}`
    }
    if (!l) return null
    return {
      goal, start: `/p/${pid}`, startWait: 3000, writes: false,
      plan: [{ title: 'Find the line with the answer', check: 'the line is visible' }],
      steps: [{ plan: 1, do: 'click', target: target(l), mayNotChange: true }],
      answer,
      verify: async ({ sh }) => strip(getText(sh, pid)).includes(answer.split(', ').at(-1).replace(/^\d+ people$/, '').trim() || answer)
    }
  },

  // Create a new doc by name and write its title line.
  create_pad: async ({ rng }) => {
    const topic = rng.pick(['hiring-plan', 'launch-checklist', 'retro-notes', 'budget-draft', 'vendor-review', 'team-goals', 'support-playbook', 'release-notes'])
    const name = `${topic}-${rng.pick(['oct', 'nov', 'dec'])}-${rng.int(1, 28)}`
    if (pads().includes(name)) return null
    const title = `${topic.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')} (${rng.pick(['draft', 'v1', 'for review'])})`
    return {
      goal: rng.pick([`Create a new doc named ${name} and write "${title}" as its first line.`, `Start a pad called ${name} with the title line "${title}".`]),
      start: '/',
      plan: [{ title: `Open a pad named ${name}`, check: `url contains /p/${name}` }, { title: `Type "${title}" on the first line`, check: `text "${title}"` }],
      steps: [{ plan: 1, do: 'type', target: { role: 'textbox', name: /Pad name/ }, text: name },
        { plan: 1, do: 'click', target: { role: 'button', name: 'Open pad by name' }, settle: 3500 },
        { plan: 2, do: 'click', target: { role: 'paragraph', nth: 0 }, mayNotChange: true, settle: 500 },
        { plan: 2, do: 'type', target: DOC, text: title, slowly: true, settle: 2000 }],
      answer: `Created ${name} with the title "${title}".`,
      verify: async ({ sh }) => getText(sh, name).startsWith(title)
    }
  }
}

export default {
  name: 'etherpad',
  family: 'docs',
  origin: 'http://docs.farm.test',
  portOffset: 31,
  explorePaths: ['/'],
  async reset({ sh }) { sh('python3 /workspace/clone-farm/etherpad/reset.py') },
  async login({ page, sleep }) { await page.goto('http://docs.farm.test/').catch(() => {}); await sleep(1000) },
  // A task returns null when the random pick does not fit (ties, duplicates): try a few picks.
  tasks: Object.fromEntries(Object.entries(tasks).map(([k, fn]) => [k, async (ctx) => { for (let i = 0; i < 12; i++) { const s = await fn(ctx); if (s) return s } return null }]))
}
