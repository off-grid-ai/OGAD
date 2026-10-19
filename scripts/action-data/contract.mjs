// Request text for the planner, actor and evaluator, exactly as docs/MODEL_CONTRACT.md defines it.
// Training rows and the OGAD harness must build requests with the same functions.

const PAST_ACTIONS = 10
// Same 18k limit as OGAD's boundedSnapshot (src/main/browser/browser-playwright-policy.ts), with a
// compaction step and a cut that keeps controls: see boundedSnapshot below.
const MAX_SNAPSHOT_CHARS = 18_000
const COMMON = new Set(['open', 'find', 'tell', 'what', 'which', 'with', 'from', 'that', 'this', 'page', 'shown', 'about', 'there', 'their', 'have', 'into', 'then', 'article', 'website', 'https', 'http', 'www'])

function goalTerms(goal) {
  return [...new Set(goal.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? [])].filter((word) => !COMMON.has(word))
}

// Lines that carry no meaning for the models: unnamed generic wrappers and link targets.
const WRAPPER = /^\s*- generic(?: \[active\])? \[ref=[^\]]+\]:?\s*$/
const LINK_URL = /^\s*- \/url:/
const ACTIONABLE = /^\s*- '?(textbox|searchbox|combobox|checkbox|radio|button|link|option|tab|menuitem|switch|slider|spinbutton|row|cell|listitem|img)\b.*\[ref=/

/** Drop wrapper and URL lines. Refs and indentation of everything else stay as they are. */
export function compactSnapshot(snapshot) {
  return snapshot.split('\n').filter((line) => !WRAPPER.test(line) && !LINK_URL.test(line)).join('\n')
}

/**
 * The snapshot the models see: compacted, then cut to the limit if still too long. The cut keeps
 * the page header, lines about the current plan step, lines about the goal (with neighbours), then controls the actor can act on,
 * then other text — in page order. On real sites nearly every line has a ref, so a cut that only
 * prefers "lines with refs" keeps the top of the page and loses the target.
 */
export function boundedSnapshot(snapshot, goal = '', focus = '', limit = MAX_SNAPSHOT_CHARS) {
  const compact = compactSnapshot(snapshot)
  if (compact.length <= limit) return compact
  const lines = compact.split('\n')
  const terms = goalTerms(goal)
  const picked = new Set()
  let used = 0
  const take = (index) => {
    if (index < 0 || index >= lines.length || picked.has(index)) return
    const cost = (lines[index] ?? '').length + 1
    if (used + cost > limit - 200) return
    picked.add(index)
    used += cost
  }
  const around = (index, reach) => { for (let offset = -reach; offset <= reach; offset += 1) take(index + offset) }
  for (let index = 0; index < 6; index += 1) take(index)
  // The current plan step names what the actor needs now, so its lines come first.
  const focusTerms = goalTerms(focus)
  lines.forEach((line, index) => { const lower = line.toLowerCase(); if (focusTerms.some((term) => lower.includes(term))) around(index, 1) })
  lines.forEach((line, index) => { const lower = line.toLowerCase(); if (terms.some((term) => lower.includes(term))) around(index, 1) })
  lines.forEach((line, index) => { if (ACTIONABLE.test(line)) take(index) })
  lines.forEach((_, index) => take(index))
  const kept = [...picked].sort((left, right) => left - right).map((index) => lines[index] ?? '')
  return `[Snapshot shortened. Lines about the goal, controls and their labels retained.]\n${kept.join('\n')}`
}

// ---------- on-screen snapshot and find (contract v1 candidate; off unless a caller passes `view`) ----------

// Playwright MCP `browser_snapshot {boxes:true}` writes [box=x,y,w,h] in CSS pixels relative to
// the top-left of the viewport (not the page): after scrollTo(0, 300) a heading at page y 8 has y -292.
const BOX = / \[box=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)\]/
const BOX_ALL = / \[box=-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+\]/g
const TREE_LINE = /^\s*- /

/** The snapshot text without the [box=...] annotations: byte-equal to a snapshot taken without boxes. */
export function stripBoxes(snapshot) {
  return snapshot.replace(BOX_ALL, '')
}

const STEP_VERBS = new Set(['click', 'type', 'select', 'check', 'uncheck', 'choose', 'press', 'enter', 'fill'])
const indentOf = (line) => (line.match(/^\s*/) ?? [''])[0].length

/**
 * The snapshot the actor and evaluator see under contract v1: what is on screen, like the
 * screenshot, plus one screen below. Rules, in this order:
 * 1. The page header (lines before the YAML tree) and the closing lines stay.
 * 2. A line whose box intersects the window [0, width) x [0, 2 * height) stays. A line with no box
 *    (text, /url) takes the state of the nearest line above it that has a box.
 * 3. A line about the current plan step (focus terms) stays, wherever it is on the page.
 * 4. Every kept line keeps its ancestor lines, so the tree structure stays readable.
 * Then the boxes are removed, wrapper and URL lines are dropped (compactSnapshot), one line says how
 * many controls are not shown, and boundedSnapshot applies the 18k limit as a last safety cut.
 * Iframe content (refs fN…) has boxes in the frame's own viewport; it is offset by the box of the
 * iframe line that contains it.
 */
export function viewportSnapshot(snapshotWithBoxes, viewport, focus = '', goal = '', limit = MAX_SNAPSHOT_CHARS) {
  // below: screens kept under the viewport (default 1). Only the measurement script changes it.
  const { width, height, below: screensBelow = 1 } = viewport
  const lines = snapshotWithBoxes.split('\n')
  const treeStart = lines.findIndex((line, i) => i > 0 && TREE_LINE.test(line) && lines[i - 1].startsWith('```'))
  let treeEnd = lines.length
  for (let i = lines.length - 1; i > treeStart; i -= 1) if (lines[i].startsWith('```')) { treeEnd = i; break }
  const start = treeStart < 0 ? lines.length : treeStart
  // Plan-step verbs name the action, not the target; "check" would also match every checkbox.
  const focusTerms = goalTerms(focus).filter((term) => !STEP_VERBS.has(term))
  const keep = new Array(lines.length).fill(false)
  const parent = new Array(lines.length).fill(-1)
  const where = new Array(lines.length).fill(0) // 0 in window, 1 below, -1 above, 2 beside
  const stack = [] // open ancestors: { index, indent, dx, dy } (dx, dy = frame offset for children)
  let lastState = 0
  for (let i = start; i < treeEnd; i += 1) {
    const line = lines[i]
    if (!line.trim()) continue
    const indent = indentOf(line)
    while (stack.length && stack.at(-1).indent >= indent) stack.pop()
    parent[i] = stack.length ? stack.at(-1).index : -1
    const offset = stack.length ? stack.at(-1) : { dx: 0, dy: 0 }
    const box = line.match(BOX)
    let dx = offset.dx
    let dy = offset.dy
    if (box) {
      const [x, y, w, h] = box.slice(1, 5).map(Number)
      const left = x + offset.dx
      const top = y + offset.dy
      lastState = top >= (1 + screensBelow) * height ? 1 : top + h <= 0 ? -1 : left >= width || left + w <= 0 ? 2 : 0
      // Children of an iframe line are laid out in the frame's own viewport.
      if (/^\s*- '?iframe\b/.test(line)) { dx = left; dy = top }
    }
    where[i] = lastState
    if (TREE_LINE.test(line)) stack.push({ index: i, indent, dx, dy })
    const lower = stripBoxes(line).toLowerCase()
    keep[i] = lastState === 0 || (focusTerms.length > 0 && focusTerms.some((term) => lower.includes(term)))
  }
  for (let i = start; i < treeEnd; i += 1) {
    if (!keep[i]) continue
    for (let p = parent[i]; p >= 0 && !keep[p]; p = parent[p]) keep[p] = true
  }
  let below = 0
  let above = 0
  const out = []
  // (below / above count controls that are not shown)
  lines.forEach((line, i) => {
    if (i < start || i >= treeEnd) { out.push(line); return }
    if (keep[i]) { out.push(line); return }
    if (ACTIONABLE.test(stripBoxes(line))) { if (where[i] === 1) below += 1; else if (where[i] === -1) above += 1 }
  })
  let text = compactSnapshot(stripBoxes(out.join('\n')))
  if (below || above) text += `\n[${below} more controls below, ${above} above. Use scroll_down(), scroll_up() or find("text").]`
  return boundedSnapshot(text, goal, focus, limit)
}

const MAX_FIND = 8
const FIND_NAME = 60

/**
 * The result of find("text"): lines of the full snapshot that contain the text (case-insensitive;
 * the accessible name is part of the line). A line without a ref is reported by its nearest
 * ancestor with a ref. Controls come first, then other lines, each in page order; at most 8.
 * The refs are valid targets for the next action, also when the on-screen snapshot does not show them.
 */
export function findResult(snapshot, text) {
  const needle = String(text).toLowerCase().trim()
  if (!needle) return '0 matches'
  const compact = compactSnapshot(stripBoxes(snapshot))
  const lines = compact.split('\n')
  const stack = []
  const seen = new Set()
  const controls = []
  const others = []
  for (const line of lines) {
    if (!TREE_LINE.test(line)) continue
    const indent = indentOf(line)
    while (stack.length && stack.at(-1).indent >= indent) stack.pop()
    const m = line.match(LINE)
    if (m) stack.push({ indent, ref: m[5], line })
    if (!line.toLowerCase().includes(needle)) continue
    const holder = m ? { ref: m[5], line } : stack.at(-1)
    if (!holder || seen.has(holder.ref)) continue
    seen.add(holder.ref)
    ;(ACTIONABLE.test(holder.line) ? controls : others).push(holder)
  }
  const hits = [...controls, ...others]
  if (!hits.length) return '0 matches'
  const describe = ({ ref, line }) => {
    const m = line.match(LINE)
    const role = m?.[2] ?? 'generic'
    const name = targetText(compact, ref)
    return name ? `${ref} ${role} ${JSON.stringify(name)}` : `${ref} ${role}`
  }
  const shown = hits.slice(0, MAX_FIND).map(describe).join('; ')
  return `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}${hits.length > MAX_FIND ? ` (first ${MAX_FIND})` : ''}: ${shown}`
}

/**
 * The text to find a target by: its accessible name, else its own text, else the first named or
 * text line inside it. Empty when it has none. Cut at 60 characters (a prefix still matches).
 */
export function targetText(snapshot, ref) {
  const lines = compactSnapshot(stripBoxes(snapshot)).split('\n')
  const at = lines.findIndex((l) => l.includes(`[ref=${ref}]`))
  if (at < 0) return ''
  const own = (line) => {
    const m = line.match(LINE)
    const name = (m?.[3] ?? '').replace(/\\"/g, '"')
    if (name) return name
    const text = line.match(/^\s*- (?:'?\w+(?: \[[^\]]*\])*: |text: )(.+)$/)?.[1] ?? ''
    return text.replace(/^'|'$/g, '').replace(/^"|"$/g, '').trim()
  }
  const indent = indentOf(lines[at])
  let text = own(lines[at])
  for (let i = at + 1; !text && i < lines.length && indentOf(lines[i]) > indent; i += 1) text = own(lines[i])
  return text.slice(0, FIND_NAME)
}

/** Refs a find result names: valid targets for the next action. */
export function findRefs(result) {
  return [...String(result).matchAll(/(?:^|[:;] )((?:f\d+)?e\d+) /g)].map((m) => m[1])
}

export function planLines(plan, current, withChecks = false) {
  return plan.map((step, index) => {
    const n = index + 1
    const mark = n < current ? '[x]' : n === current ? '[>]' : '[ ]'
    return `${mark} ${n} ${step.title}${withChecks ? ` | check: ${step.check}` : ''}`
  }).join('\n')
}

export function pastLines(past, count = PAST_ACTIONS) {
  const shown = past.slice(-count)
  const offset = past.length - shown.length
  return shown.map((entry, index) => `${offset + index + 1} ${entry}`).join('\n')
}

export function plannerRequest({ goal, snapshot, done, reason }) {
  const lines = [`GOAL: ${goal}`, 'AX:', boundedSnapshot(snapshot, goal)]
  if (done?.length) {
    lines.splice(1, 0, 'DONE:', done.map((step, i) => `[x] ${i + 1} ${step.title}`).join('\n'), `REASON: ${reason}`)
  }
  return lines.join('\n')
}

// The answer request: once the evaluator says the task is done, the planner (text-only, the stronger
// writer) reads the final page and writes the complete answer. The reply is the answer text alone.
export const ANSWER_TASK = 'TASK: write the complete answer to the goal from this page.'
export function answerRequest({ goal, snapshot }) {
  return [`GOAL: ${goal}`, ANSWER_TASK, 'AX:', boundedSnapshot(snapshot, goal)].join('\n')
}

export function plannerResponse(plan, firstNumber = 1) {
  return plan.map((step, index) => `${firstNumber + index} ${step.title} | check: ${step.check}`).join('\n')
}

// Stable parts first (goal, plan), then the parts that change every step (past, image, AX), so the
// runtime can reuse the processed prefix between steps.

// ---------- harness checks and obvious steps ----------
// Exact work the harness does itself, so the models only make choices. Pure functions of the
// snapshot text: the generator and OGAD's harness must give identical results.

const unq = (v) => v.replace(/^"(.*)"$/, '$1')

/** A plan step's check, in the forms the planner writes. Null when code cannot test it. */
export function parseCheck(check) {
  if (!check) return null
  let m = check.match(/^(textbox|combobox|searchbox|spinbutton) "(.+?)"(?: in (.+?))? = (.+)$/)
  if (m) return { kind: 'field', role: m[1], name: m[2], section: m[3] ?? null, value: m[4] }
  m = check.match(/^checkbox "(.+?)"(?: in (.+?))? (checked|not checked)$/)
  if (m) return { kind: 'checked', name: m[1], section: m[2] ?? null, checked: m[3] === 'checked' }
  m = check.match(/^(?:textbox "(.+?)"(?: in (.+?))? is empty)$/)
  if (m) return { kind: 'field', role: 'textbox', name: m[1], section: m[2] ?? null, value: '' }
  m = check.match(/^text "(.+)"$/)
  if (m) return { kind: 'text', text: m[1] }
  m = check.match(/^url contains (.+)$/)
  if (m) return { kind: 'url', part: m[1] }
  m = check.match(/^heading "(.+)"$/)
  if (m) return { kind: 'heading', name: m[1] }
  return null
}

const LINE = /^(\s*)- '?(\w+)(?: "((?:[^"\\]|\\.)*)")?([^\n]*?)\[ref=((?:f\d+)?e\d+)\]([^\n]*)$/

function parsedLines(snapshot) {
  return snapshot.split('\n').map((text, index) => {
    const m = text.match(LINE)
    return m ? { index, indent: m[1].length, role: m[2], name: (m[3] ?? '').replace(/\\"/g, '"'), flags: m[4] + m[6], ref: m[5], text } : { index, indent: (text.match(/^\s*/) ?? [''])[0].length, text }
  }).filter((l) => l.text.trim())
}

/** Lines inside the region or group named `section`, or all lines. */
function scope(lines, section) {
  if (!section) return lines
  const head = lines.find((l) => (l.role === 'region' || l.role === 'group' || l.role === 'heading') && l.name === section)
  if (!head) return []
  if (head.role === 'heading') {
    const start = lines.indexOf(head)
    const end = lines.findIndex((l, i) => i > start && l.role === 'heading')
    return lines.slice(start, end < 0 ? undefined : end)
  }
  const start = lines.indexOf(head)
  const out = []
  for (let i = start + 1; i < lines.length && lines[i].indent > head.indent; i++) out.push(lines[i])
  return out
}

const fieldValue = (line) => {
  const m = line.text.match(/\]: (.*)$/) ?? line.text.match(/\]\s*:\s*(.*)$/)
  return m ? unq(m[1].trim().replace(/'$/, '')) : ''
}

/** true / false, or null when the check cannot be tested from the snapshot. */
export function evaluateCheck(check, snapshot) {
  const c = parseCheck(check)
  if (!c) return null
  const lines = parsedLines(snapshot)
  switch (c.kind) {
    case 'field': {
      const hits = scope(lines, c.section).filter((l) => l.ref && l.name === c.name && (l.role === c.role || (c.role === 'textbox' && l.role === 'searchbox')))
      if (hits.length !== 1) return null
      if (c.role === 'combobox') {
        const start = lines.indexOf(hits[0])
        const selected = lines.slice(start + 1).find((l) => l.indent <= hits[0].indent ? true : /\[selected\]/.test(l.text))
        return Boolean(selected && /\[selected\]/.test(selected.text) && selected.text.includes(`"${c.value}"`))
      }
      return fieldValue(hits[0]) === c.value
    }
    case 'checked': {
      const hits = scope(lines, c.section).filter((l) => l.ref && l.role === 'checkbox' && l.name === c.name)
      if (hits.length !== 1) return null
      return /\[checked\]/.test(hits[0].flags) === c.checked
    }
    case 'text': return snapshot.toLowerCase().includes(c.text.toLowerCase())
    case 'url': return ((snapshot.match(/Page URL: (.*)/) ?? [])[1] ?? '').includes(c.part)
    case 'heading': return lines.some((l) => l.role === 'heading' && l.name === c.name)
    default: return null
  }
}

/** The CHECKS block: one mark per plan step. ✓ met, ✗ not met, ? cannot be tested. */
export function checkLines(plan, snapshot) {
  return plan.map((step, i) => {
    const r = evaluateCheck(step.check, snapshot)
    return `${i + 1} ${r === true ? '✓' : r === false ? '✗' : '?'}`
  }).join(' ')
}

/**
 * The action for a step whose target is exactly one control, so the harness can act without the
 * actor. Null when the target is missing, ambiguous, disabled, or the step is already done.
 */
export function obviousAction(step, snapshot) {
  if (!step) return null
  const c = parseCheck(step.check)
  const lines = parsedLines(snapshot)
  const q = JSON.stringify
  const usable = (l) => l.ref && !/\[disabled\]/.test(l.flags)
  if (c?.kind === 'field' && evaluateCheck(step.check, snapshot) === false) {
    const hits = scope(lines, c.section).filter((l) => usable(l) && l.name === c.name && (l.role === c.role || (c.role === 'textbox' && l.role === 'searchbox')))
    if (hits.length !== 1) return null
    if (c.role === 'combobox') return `select(${hits[0].ref},${q(c.value)})`
    return c.value === '' ? `clear(${hits[0].ref})` : `type(${hits[0].ref},${q(c.value)})`
  }
  if (c?.kind === 'checked' && evaluateCheck(step.check, snapshot) === false) {
    const hits = scope(lines, c.section).filter((l) => usable(l) && l.role === 'checkbox' && l.name === c.name)
    if (hits.length !== 1) return null
    return `${c.checked ? 'check' : 'uncheck'}(${hits[0].ref})`
  }
  const m = step.title.match(/^(?:Click|Open) (.+)$/)
  // A click step is obvious when its check is about the result (text, URL, heading) and not met yet.
  if (m && (!c || ['text', 'url', 'heading'].includes(c.kind)) && evaluateCheck(step.check, snapshot) !== true) {
    const hits = lines.filter((l) => usable(l) && (l.role === 'button' || l.role === 'link' || l.role === 'tab') && l.name === m[1])
    if (hits.length === 1) return `click(${hits[0].ref})`
  }
  return null
}

/**
 * A success claim the harness can trust. With no action taken yet, the answer must be on the page
 * (the goal was already met when the task started); otherwise any answer passes to the evaluator's
 * judgement. Generated data always meets this rule.
 */
export function successIsBacked(answer, snapshot, actionsTaken) {
  if (actionsTaken > 0) return true
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9₹$€.%]+/g, ' ').trim()
  const words = norm(answer).split(' ').filter((w) => w.length > 2)
  if (!words.length) return false
  const page = norm(snapshot)
  return words.filter((w) => page.includes(w)).length / words.length >= 0.8
}

const focusOf = (plan, current) => plan[current - 1]?.title ?? ''

// `view` ({ boxed, width, height }: the snapshot with boxes and the viewport size) switches AX to
// the on-screen snapshot of contract v1. Without it, AX is the 18k boundedSnapshot (contract v0).
const axText = ({ goal, plan, current, snapshot, view }) => view
  ? viewportSnapshot(view.boxed, view, focusOf(plan, current), goal)
  : boundedSnapshot(snapshot, goal, focusOf(plan, current))

export function actorRequest({ goal, plan, current, past, snapshot, view }) {
  return [
    `GOAL: ${goal}`,
    'PLAN:',
    planLines(plan, current),
    'PAST:',
    past.length ? pastLines(past) : '(none)',
    '<image>',
    'AX:',
    axText({ goal, plan, current, snapshot, view })
  ].join('\n')
}

export function evaluatorRequest({ goal, plan, current, past, last, snapshot, view }) {
  return [
    `GOAL: ${goal}`,
    'PLAN:',
    planLines(plan, current, true),
    `CHECKS: ${checkLines(plan, snapshot)}`,
    'PAST:',
    // LAST is usually the newest PAST entry; show the 3 actions before it.
    (() => { const prior = last === past.at(-1) ? past.slice(0, -1) : past; return prior.length ? pastLines(prior, 3) : '(none)' })(),
    `LAST: ${last}`,
    '<image>',
    'AX:',
    axText({ goal, plan, current, snapshot, view })
  ].join('\n')
}
