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
  /** Native numeric range metadata for value-aware controls such as sliders. */
  minValue?: number
  maxValue?: number
  valueSettable?: boolean
  /** Element-center in screen pixels, for a click or AXPress dispatch. */
  cx: number
  cy: number
  /** Exact screen-pixel bounds from AX/UIA. */
  x?: number
  y?: number
  width?: number
  height?: number
  /** Stable only for equivalent observations of the same window. */
  stableId?: string
  source?: 'ax' | 'ocr' | 'ax+ocr'
  processId?: number
  windowId?: string
  revision?: number
  region?: string
  checked?: boolean
  /** True when AX/UIA reports a selected option, tab, row, or menu item. */
  selected?: boolean
  /** True when activating the item opens a nested menu or popup. */
  hasPopup?: boolean
  /** True when the OS reports keyboard focus on this element. */
  focused?: boolean
  /** False for observation-only evidence such as OCR text. */
  executable?: boolean
  risk?: 'reversible' | 'private' | 'authentication' | 'payment' | 'destructive'
  /** Exposes AXPress - a press is preferred over a synthetic click when true. */
  actionable: boolean
  enabled: boolean
}

export interface AxSnapshot {
  windowTitle: string
  elements: AxElement[]
  /** Visible OCR text from the captured window. This includes screen-level
   * overlays that are not present in the target process's AX tree. */
  visibleText?: string
  processId?: number
  processName?: string
  windowId?: string
  /** Native window handle used for exact capture. It is valid only while this window exists. */
  platformWindowId?: number
  windowBounds?: { x: number; y: number; width: number; height: number }
  revision?: number
  degradedReason?: string
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
  pid?: unknown
  process?: unknown
  windowId?: unknown
  platformWindowId?: unknown
  windowX?: unknown
  windowY?: unknown
  windowW?: unknown
  windowH?: unknown
  revision?: unknown
  checked?: unknown
  selected?: unknown
  hasPopup?: unknown
  focused?: unknown
  executable?: unknown
  minValue?: unknown
  maxValue?: unknown
  valueSettable?: unknown
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
  let processId = 0
  let processName = ''
  let windowId = ''
  let platformWindowId = 0
  let revision = 0
  let windowBounds = { x: 0, y: 0, width: 0, height: 0 }
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) {
      continue
    }
    if (line.startsWith('[WINDOW_TITLE]')) {
      windowTitle = line.slice('[WINDOW_TITLE]'.length).trim()
      continue
    }
    if (line.startsWith('[WINDOW_CONTEXT]')) {
      try {
        const context = JSON.parse(line.slice('[WINDOW_CONTEXT]'.length).trim()) as RawElement
        processId = Math.round(num(context.pid))
        processName = str(context.process)
        windowId = str(context.windowId)
        platformWindowId = Math.max(0, Math.round(num(context.platformWindowId)))
        revision = Math.max(0, Math.round(num(context.revision)))
        windowBounds = {
          x: num(context.windowX),
          y: num(context.windowY),
          width: num(context.windowW),
          height: num(context.windowH)
        }
      } catch {
        /* A legacy helper has no context line. */
      }
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
      ...(typeof parsed.minValue === 'number' ? { minValue: parsed.minValue } : {}),
      ...(typeof parsed.maxValue === 'number' ? { maxValue: parsed.maxValue } : {}),
      ...(typeof parsed.valueSettable === 'boolean'
        ? { valueSettable: parsed.valueSettable }
        : {}),
      cx: Math.round(x + w / 2),
      cy: Math.round(y + h / 2),
      x,
      y,
      width: w,
      height: h,
      stableId: `${windowId || windowTitle}:${role}:${str(parsed.label).replace(/\s+/g, ' ').trim().toLocaleLowerCase()}:${Math.round(x)}:${Math.round(y)}:${Math.round(w)}:${Math.round(h)}`,
      source: 'ax',
      processId,
      windowId,
      revision,
      ...(typeof parsed.checked === 'boolean' ? { checked: parsed.checked } : {}),
      ...(typeof parsed.selected === 'boolean' ? { selected: parsed.selected } : {}),
      ...(typeof parsed.hasPopup === 'boolean' ? { hasPopup: parsed.hasPopup } : {}),
      ...(typeof parsed.focused === 'boolean' ? { focused: parsed.focused } : {}),
      executable: parsed.executable !== false,
      actionable: parsed.press === true,
      enabled: parsed.enabled !== false
    })
  }
  elements.forEach((el, i) => {
    el.index = i + 1
  })
  if (windowBounds.width <= 0 || windowBounds.height <= 0) {
    const visible = elements.filter(
      (element) => (element.width ?? 0) > 0 && (element.height ?? 0) > 0
    )
    if (visible.length) {
      const left = Math.min(...visible.map((element) => element.x ?? element.cx))
      const top = Math.min(...visible.map((element) => element.y ?? element.cy))
      const right = Math.max(
        ...visible.map((element) => (element.x ?? element.cx) + (element.width ?? 0))
      )
      const bottom = Math.max(
        ...visible.map((element) => (element.y ?? element.cy) + (element.height ?? 0))
      )
      windowBounds = { x: left, y: top, width: right - left, height: bottom - top }
    }
  }
  return {
    windowTitle,
    elements,
    processId,
    processName,
    windowId: windowId || `${processId}:${windowTitle}`,
    ...(platformWindowId > 0 ? { platformWindowId } : {}),
    windowBounds,
    revision
  }
}

/** The numbered element list rendered for the model - same shape as the browser
 *  collector's, so the model faces one consistent "pick [n]" surface. */
export function formatAxElementsForModel(
  snapshot: AxSnapshot,
  maxElements = Number.POSITIVE_INFINITY
): string {
  const lines = snapshot.elements.slice(0, maxElements).map((el) => {
    const parts = [`[${el.index}]`, el.role]
    if (el.name) {
      parts.push(JSON.stringify(el.name))
    }
    if (el.value) {
      parts.push(`value=${JSON.stringify(el.value.slice(0, 240))}`)
    }
    if (!el.enabled) {
      parts.push('(disabled)')
    }
    if (el.executable === false) {
      parts.push('(evidence only)')
    }
    return parts.join(' ')
  })
  const omitted =
    snapshot.elements.length > maxElements
      ? `\n(${snapshot.elements.length - maxElements} more elements omitted)`
      : ''
  return `Window: ${snapshot.windowTitle}\nInteractive elements:\n${lines.join('\n')}${omitted}`
}
