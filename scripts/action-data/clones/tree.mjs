// Snapshot parsing for clone-capture: find a control by role and name, as a person would name it.

/** Only our own clone hosts: write actions run nowhere else. */
export const CLONE_HOST = /^[a-z0-9-]+\.farm\.test$/

// A name with a colon makes the YAML line single-quoted: - 'link "A: B" [ref=e1]'
const LINE = /^(\s*)- '?([\w-]+)(?: "((?:[^"\\]|\\.)*)")?(.*?)(?:\[ref=((?:f\d+)?e\d+)\]([^\n]*))?$/
const UNSAFE = /\b(buy|checkout|pay|subscribe|sign ?out|log ?out|logout|delete|remove|report|download|install|upgrade|send|submit|post|reply|share)\b/i

// A single-quoted YAML line doubles its apostrophes: - 'button "Parents'' day" [ref=e1]'
const unquote = (name, raw) => { const n = name.replace(/\\"/g, '"').trim(); return /^\s*- '/.test(raw) ? n.replace(/''/g, "'") : n }

/** Snapshot lines as nodes with parent links. */
export function parseTree(snapshot) {
  const nodes = []
  const stack = []
  for (const raw of snapshot.split('\n')) {
    const m = raw.match(LINE)
    if (!m || !raw.trim().startsWith('-')) continue
    const indent = m[1].length
    // Text after the ref and its [attr] tags: `- textbox "To" [ref=e5]: rohan@x.test` -> value
    // Lines without a ref (`- text: Send`, `- generic: x`) keep their text the same way.
    const tail = m[5] ? (m[6] ?? '') : (m[4] ?? '')
    const value = (tail.match(/^(?:\s*\[[^\]]*\])*:\s+(.+)$/) ?? [])[1] ?? ''
    while (stack.length && stack.at(-1).indent >= indent) stack.pop()
    const node = { indent, role: m[2], name: unquote(m[3] ?? '', raw), ref: m[5] ?? null, value: value.replace(/^"(.*)"$/, '$1'), line: raw.trim(), parent: stack.at(-1) ?? null, children: [] }
    node.parent?.children.push(node)
    nodes.push(node)
    stack.push(node)
  }
  return nodes
}

const textCache = new WeakMap()
/** All text of a node and its descendants. */
export function subtreeText(node) {
  if (textCache.has(node)) return textCache.get(node)
  const t = [node.name, node.value, ...node.children.map(subtreeText)].filter(Boolean).join(' ')
  textCache.set(node, t)
  return t
}

const matches = (want, got) => want == null || (want instanceof RegExp ? want.test(got) : want === got)

/**
 * Nodes with a ref that match { role, name, value, inside, under }:
 * - role / name / value: exact string or RegExp
 * - inside: RegExp, some ancestor's whole text matches (a row, list item or dialog with that text)
 * - insideRole: role of that ancestor (default any)
 * - insideDepth: only look at this many ancestors for `inside` (default all)
 * - under: RegExp tested against each ancestor's own "role name"
 * - text: RegExp on the node's own whole text (for unnamed controls: generic > "Send")
 */
export function findTargets(nodes, target) {
  return nodes.filter((n) => {
    if (!n.ref || !matches(target.role, n.role) || !matches(target.name, n.name) || !matches(target.value, n.value)) return false
    if (target.text && !target.text.test(subtreeText(n))) return false
    if (target.inside) {
      let a = n.parent; let ok = false; let depth = 0
      for (; a && !ok && depth < (target.insideDepth ?? Infinity); a = a.parent, depth++) ok = matches(target.insideRole, a.role) && target.inside.test(subtreeText(a))
      if (!ok) return false
    }
    if (target.under) {
      let a = n.parent; let ok = false
      for (; a && !ok; a = a.parent) ok = target.under.test(`${a.role} ${a.name}`)
      if (!ok) return false
    }
    return true
  })
}

/** Named controls that only navigate, for explore tasks. */
export function safeControls(nodes) {
  return nodes.filter((n) => n.ref && n.name && n.name.length >= 2 && n.name.length <= 60 && !UNSAFE.test(n.name))
}
