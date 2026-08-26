/**
 * The browser rail's eyes: an in-page collector that walks the live DOM and
 * returns the indexed interactive elements the agent can act on, plus the
 * page's readable text. Ported design: nanobrowser's injected dom module +
 * browser-use's clickable-element detection and numeric indexing.
 *
 * The collector runs INSIDE the page (serialized via `pageScriptSource` and
 * evaluated over CDP), so this module must stay dependency-free and use only
 * browser globals. That also makes it directly unit-testable in jsdom: the
 * tests call `collectInteractiveElements(document)` against a constructed DOM
 * - the exact code the driver injects, not a re-implementation.
 */

export interface PageElement {
  /** The number the model refers to ("click 12") - stable within one snapshot. */
  index: number
  tag: string
  /** ARIA role when present, else the tag's implicit interactive kind. */
  role: string
  /** Best available accessible name: aria-label, text, placeholder, alt, title. */
  name: string
  /** input/textarea current value (never for password fields). */
  value: string
  /** Viewport-relative center, for CDP mouse dispatch. */
  cx: number
  cy: number
  /** True for password / one-time-code fields - the driver REFUSES to type into
   *  these; they mark the identity boundary where the human takes over. */
  identity: boolean
  href: string
  /** Control state needed to verify toggles, menus, and selected options. */
  state?: string
  disabled?: boolean
}

export interface PageSnapshot {
  url: string
  title: string
  elements: PageElement[]
  /** Readable page text, whitespace-collapsed and capped. */
  text: string
}

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary'])
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox'
])

function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase()
  if (INTERACTIVE_TAGS.has(tag)) {
    return true
  }
  const role = el.getAttribute('role')
  if (role && INTERACTIVE_ROLES.has(role)) {
    return true
  }
  return (el as HTMLElement).onclick != null || el.hasAttribute('onclick')
}

function isVisible(el: Element, win: Window): boolean {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) {
    return false
  }
  const style = win.getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false
  }
  const input = el as HTMLInputElement
  return !(el.tagName.toLowerCase() === 'input' && input.type === 'hidden')
}

function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label')
  if (aria?.trim()) {
    return aria.trim()
  }
  const labelled = el.getAttribute('aria-labelledby')
  if (labelled) {
    const target = el.ownerDocument.getElementById(labelled)
    const targetText = target?.textContent.trim()
    if (targetText) {
      return targetText
    }
  }
  const text = el.textContent.trim().replace(/\s+/g, ' ')
  if (text) {
    return text.slice(0, 120)
  }
  for (const attr of ['placeholder', 'alt', 'title', 'name']) {
    const v = el.getAttribute(attr)
    if (v?.trim()) {
      return v.trim()
    }
  }
  return ''
}

/** Password and one-time-code fields mark the identity boundary: the agent never
 *  reads or types them; the human takes over the watched pane. */
function isIdentityField(el: Element): boolean {
  if (el.tagName.toLowerCase() !== 'input') {
    return false
  }
  const input = el as HTMLInputElement
  return input.type === 'password' || el.getAttribute('autocomplete') === 'one-time-code'
}

function controlState(el: Element): { state: string; disabled: boolean } {
  const input = el as HTMLInputElement
  const parts: string[] = []
  const add = (name: string, value: string | null | boolean | undefined): void => {
    if (value === null || value === undefined || value === false || value === '') return
    parts.push(value === true ? name : `${name}=${value}`)
  }
  add('checked', input.checked)
  add('selected', (el as HTMLOptionElement).selected)
  add('expanded', el.getAttribute('aria-expanded'))
  add('pressed', el.getAttribute('aria-pressed'))
  add('current', el.getAttribute('aria-current'))
  add('readonly', input.readOnly || el.getAttribute('aria-readonly') === 'true')
  return {
    state: parts.join(','),
    disabled: input.disabled || el.getAttribute('aria-disabled') === 'true'
  }
}

/**
 * Walks the document (including same-origin open shadow roots) and returns the
 * snapshot the agent reasons over. Runs in-page; jsdom-compatible on purpose.
 */
export function collectInteractiveElements(doc: Document): PageSnapshot {
  const win = doc.defaultView as Window
  const elements: PageElement[] = []
  const walk = (root: ParentNode): void => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const shadow = (el as HTMLElement).shadowRoot
      if (shadow) {
        walk(shadow)
      }
      if (!isInteractive(el) || !isVisible(el, win)) {
        continue
      }
      const rect = el.getBoundingClientRect()
      const identity = isIdentityField(el)
      const input = el as HTMLInputElement
      const control = controlState(el)
      elements.push({
        index: 0,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
        name: accessibleName(el),
        value: identity ? '' : input.value,
        cx: Math.round(rect.left + rect.width / 2),
        cy: Math.round(rect.top + rect.height / 2),
        identity,
        href: el.getAttribute('href') ?? '',
        ...(control.state ? { state: control.state } : {}),
        ...(control.disabled ? { disabled: true } : {})
      })
    }
  }
  walk(doc)
  elements.forEach((el, i) => {
    el.index = i + 1
  })
  return {
    url: doc.location.href,
    title: doc.title,
    elements,
    text: doc.body.textContent.replace(/\s+/g, ' ').trim().slice(0, 4000)
  }
}

/**
 * The exact source evaluated in the page over CDP (Runtime.evaluate). One
 * function graph, serialized - the injected code IS the unit-tested code.
 */
export function pageScriptSource(): string {
  const helpers = [
    `const INTERACTIVE_TAGS = new Set(${JSON.stringify([...INTERACTIVE_TAGS])})`,
    `const INTERACTIVE_ROLES = new Set(${JSON.stringify([...INTERACTIVE_ROLES])})`,
    isInteractive.toString(),
    isVisible.toString(),
    accessibleName.toString(),
    isIdentityField.toString(),
    controlState.toString(),
    collectInteractiveElements.toString()
  ].join('\n')
  return `(() => {\n${helpers}\nreturn JSON.stringify(collectInteractiveElements(document))\n})()`
}

/** The snapshot rendered for the model: numbered elements, then page text. */
export function formatSnapshotForModel(snapshot: PageSnapshot, maxElements = 150): string {
  const lines = snapshot.elements.slice(0, maxElements).map((el) => {
    const parts = [`[${el.index}]`, el.role]
    if (el.name) {
      parts.push(JSON.stringify(el.name))
    }
    if (el.value) {
      parts.push(`value=${JSON.stringify(el.value.slice(0, 60))}`)
    }
    if (el.identity) {
      parts.push('(identity field - takeover required)')
    }
    if (el.state) parts.push(`state=${el.state}`)
    if (el.disabled) parts.push('(disabled)')
    return parts.join(' ')
  })
  const omitted =
    snapshot.elements.length > maxElements
      ? `\n(${snapshot.elements.length - maxElements} more elements omitted)`
      : ''
  return `Page: ${snapshot.title} (${snapshot.url})\nInteractive elements:\n${lines.join('\n')}${omitted}\n\nPage text: ${snapshot.text.slice(0, 1500)}`
}
