/**
 * The accessibility driving rail's eyes (R5 T1a): parse the macOS AX helper's
 * structured-elements output into a numbered, actionable element list the model
 * can pick from - the desktop analogue of the browser collector, deliberately
 * the same shape so the picking loop and formatter are shared, not forked.
 *
 * The helper (`text-extractor --elements <app>`) emits a `[WINDOW_TITLE]` line
 * plus one JSON object per interactive element. This is the CONTRACT the Swift
 * side must honour; it is pinned here by the tests, so a helper change that
 * breaks the shape fails a unit test rather than the live rail. Fail-closed: a
 * malformed line is skipped, never guessed.
 */

export interface AxElement {
  /** 1..n, assigned here - stable within one snapshot, how the model refers. */
  index: number
  /** AX role, e.g. AXButton, AXTextField, AXCheckBox. */
  role: string
  /** Accessible name / title - what the model picks by. */
  name: string
  /** Current value (text fields); never a secure field's contents. */
  value: string
  /** Element-center in screen pixels, for a click or AXPress dispatch. */
  cx: number
  cy: number
  /** Exposes AXPress - a press is preferred over a synthetic click when true. */
  actionable: boolean
  enabled: boolean
}

export interface AxSnapshot {
  windowTitle: string
  elements: AxElement[]
}

interface RawElement {
  role?: unknown
  label?: unknown
  value?: unknown
  x?: unknown
  y?: unknown
  w?: unknown
  h?: unknown
  press?: unknown
  enabled?: unknown
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A real, targetable control is at least this many px on each side. Below it the
 *  element is a hidden/hover artifact (Slack emits ~one 1px "Reply in thread" pair
 *  per message) - useless to click and, worse, it floods the list and buries the
 *  real controls (the composer) past the model's element cap. */
const MIN_ELEMENT_SIZE = 3

/** Parse the helper output. Element lines are JSON objects; the WINDOW_TITLE
 *  line is the app/window label. Anything else (blank lines, the text-mode
 *  markers) is ignored - the elements mode and the text mode can share a stream. */
export function parseAxElements(stdout: string): AxSnapshot {
  let windowTitle = ''
  const elements: AxElement[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      continue
    }
    if (line.startsWith('[WINDOW_TITLE]')) {
      windowTitle = line.slice('[WINDOW_TITLE]'.length).trim()
      continue
    }
    if (!line.startsWith('{')) {
      continue
    }
    let parsed: RawElement
    try {
      parsed = JSON.parse(line) as RawElement
    } catch {
      continue // fail-closed: skip a malformed element line
    }
    const role = str(parsed.role)
    if (!role) {
      continue
    }
    const x = num(parsed.x)
    const y = num(parsed.y)
    const w = num(parsed.w)
    const h = num(parsed.h)
    // Drop hidden/hover artifacts (1px buttons) - not targetable, and they bury
    // the real controls past the cap. This is fail-closed toward real controls.
    if (w < MIN_ELEMENT_SIZE || h < MIN_ELEMENT_SIZE) {
      continue
    }
    elements.push({
      index: 0,
      role,
      name: str(parsed.label).replace(/\s+/g, ' ').trim(),
      value: str(parsed.value),
      cx: Math.round(x + w / 2),
      cy: Math.round(y + h / 2),
      actionable: parsed.press === true,
      enabled: parsed.enabled !== false
    })
  }
  elements.forEach((el, i) => {
    el.index = i + 1
  })
  return { windowTitle, elements }
}

/** The numbered element list rendered for the model - same shape as the browser
 *  collector's, so the model faces one consistent "pick [n]" surface. */
export function formatAxElementsForModel(snapshot: AxSnapshot, maxElements = 120): string {
  const lines = snapshot.elements.slice(0, maxElements).map((el) => {
    const parts = [`[${el.index}]`, el.role]
    if (el.name) {
      parts.push(JSON.stringify(el.name))
    }
    if (el.value) {
      parts.push(`value=${JSON.stringify(el.value.slice(0, 60))}`)
    }
    if (!el.enabled) {
      parts.push('(disabled)')
    }
    return parts.join(' ')
  })
  const omitted =
    snapshot.elements.length > maxElements
      ? `\n(${snapshot.elements.length - maxElements} more elements omitted)`
      : ''
  return `Window: ${snapshot.windowTitle}\nInteractive elements:\n${lines.join('\n')}${omitted}`
}
