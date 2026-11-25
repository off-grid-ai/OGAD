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

export function scrubSecretValues(text: string, secrets: Iterable<string>): string {
  const values = [...new Set([...secrets].filter((value) => value.length > 0))].sort(
    (a, b) => b.length - a.length
  )
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

/** Runs in every frame of a page: the values of its password fields. Reads only. */
export const READ_PASSWORD_VALUES_SCRIPT = `(() => Array.from(document.querySelectorAll('input[type="password"]'))
  .map((input) => input.value)
  .filter((value) => typeof value === 'string' && value.length > 0))()`
