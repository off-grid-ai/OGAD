/**
 * Keeps passwords out of what the agent's models read.
 *
 * Playwright's page snapshot prints every input's value, and it gives a password field the same
 * `textbox` role as any other, so a password the Vault filled (or the person typed during a take
 * over) would reach the model as plain text. The browser reads the values of the page's password
 * fields, plus every secret the Vault filled this run, and replaces them before any snapshot or
 * tool result leaves the browser.
 */

export const SECRET_MASK = '••••••••'

/** Short values would match ordinary words, so they are masked only where a field prints them. */
const MIN_ANYWHERE = 4

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The value as it appears inside a JSON (or Playwright-quoted) string: `pa"ss` -> `pa\"ss`. */
function jsonEscaped(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

/**
 * Every way a secret can be printed: as typed, escaped once (a snapshot's quoted value, a tool
 * result serialized as JSON), and escaped twice (a snapshot inside a JSON tool result).
 */
function printedForms(value: string): string[] {
  const once = jsonEscaped(value)
  return [value, once, jsonEscaped(once)]
}

export function scrubSecretValues(text: string, secrets: Iterable<string>): string {
  const values = [
    ...new Set([...secrets].filter((value) => value.length > 0).flatMap(printedForms))
  ].sort((a, b) => b.length - a.length)
  let out = text
  for (const value of values) {
    const escaped = escapeRegExp(value)
    // A snapshot line ends with the field's value: `- textbox "Password" [ref=e5]: hunter2`.
    out = out.replace(new RegExp(`(: )${escaped}$`, 'gm'), `$1${SECRET_MASK}`)
    // Quoted in a tool result or a log line.
    out = out.replace(new RegExp(`(["'\`])${escaped}\\1`, 'g'), `$1${SECRET_MASK}$1`)
    if (value.length >= MIN_ANYWHERE) out = out.split(value).join(SECRET_MASK)
  }
  return out
}

/**
 * Runs in every frame of a journey's pages, in the page's own world. Remembers every input that
 * has been a password field, and the last value it held as one, so a password the person typed
 * during a take over stays masked after the site shows it as text (a "Show password" control
 * turns the field into `type="text"`). Installs once per document; later runs do nothing.
 */
const TRACK_PASSWORD_FIELDS = `(() => {
  const key = Symbol.for('offgrid.browser.passwordFields')
  if (window[key]) return window[key]
  const seen = new Map()
  Object.defineProperty(window, key, { value: seen })
  const isInput = (el) => el instanceof HTMLInputElement
  const remember = (el) => {
    if (isInput(el) && el.type === 'password') seen.set(el, el.value)
  }
  document.addEventListener('input', (event) => remember(event.composedPath()[0]), true)
  document.addEventListener('change', (event) => remember(event.composedPath()[0]), true)
  new MutationObserver((records) => {
    for (const record of records) {
      const el = record.target
      if (isInput(el) && String(record.oldValue).toLowerCase() === 'password' && !seen.has(el)) {
        seen.set(el, el.value)
      }
    }
  }).observe(document, { subtree: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true })
  document.querySelectorAll('input[type="password"]').forEach(remember)
  return seen
})()`

/** Runs on each page load of a journey's frames, so the tracking starts before anyone types. */
export const TRACK_PASSWORD_FIELDS_SCRIPT = `(() => { ${TRACK_PASSWORD_FIELDS}; return true })()`

/**
 * Runs in every frame of a page: the values of its password fields, including fields that were
 * password fields earlier and now show their value as text. Reads only the values.
 */
export const READ_PASSWORD_VALUES_SCRIPT = `(() => {
  const seen = ${TRACK_PASSWORD_FIELDS}
  document.querySelectorAll('input[type="password"]').forEach((el) => seen.set(el, el.value))
  const values = new Set()
  for (const [el, last] of seen) {
    values.add(last)
    values.add(el.value)
  }
  return Array.from(values).filter((value) => typeof value === 'string' && value.length > 0)
})()`
