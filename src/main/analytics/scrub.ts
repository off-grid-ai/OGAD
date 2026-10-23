/**
 * Crash scrubbing (docs/ANALYTICS.md, Crashes): replace paths with the file name only, drop any
 * quoted text, keep type, file name, line and function. URLs, hosts, IP addresses and e-mail
 * addresses are on the never-send list too, so they go as well.
 */

export interface ScrubbedFrame {
  filename: string
  function: string
  lineno?: number
  colno?: number
  in_app: boolean
}

export interface ScrubbedException {
  type: string
  value: string
  frames: ScrubbedFrame[]
}

const MAX_MESSAGE_CHARS = 300
const MAX_FRAMES = 30

const QUOTED = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’/g
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi
// A Windows path (C:\..., \\server\share\...) or a POSIX path with at least two segments.
const WINDOWS_PATH = /(?:[a-z]:\\|\\\\)[^\s:*?"<>|]*/gi
const POSIX_PATH = /(?:~|\.{1,2})?\/(?:[^\s/:]+\/)+[^\s/:]*/g
// A domain name that is not a file name: something.tld with a letters-only TLD.
const HOST =
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|co|dev|app|local|lan|internal|me|uk|de|fr|in|eu|us)\b/gi

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).at(-1) ?? ''
}

/** Scrub one free-text value (an error message or a function name). */
export function scrubText(text: string): string {
  return text
    .replace(QUOTED, '<redacted>')
    .replace(URL, '<url>')
    .replace(EMAIL, '<email>')
    .replace(WINDOWS_PATH, (path) => baseName(path))
    .replace(POSIX_PATH, (path) => baseName(path))
    .replace(IPV6, '<ip>')
    .replace(IPV4, '<ip>')
    .replace(HOST, '<host>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS)
}

/** One V8 stack line: `at fn (file:line:col)` or `at file:line:col`. */
const FRAME = /^\s*at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/

function frameOf(line: string): ScrubbedFrame | null {
  const match = FRAME.exec(line)
  if (!match) return null
  const [, fn, location, lineno, colno] = match
  const file = baseName((location ?? '').replace(/^file:\/\/+/, '/'))
  const inApp = !/node_modules|node:internal|^node:|electron\/js2c/.test(location ?? '')
  return {
    filename: file || '<unknown>',
    function: fn ? scrubText(fn).slice(0, 120) : '<anonymous>',
    lineno: Number(lineno),
    colno: Number(colno),
    in_app: inApp
  }
}

function typeOf(name: unknown): string {
  return typeof name === 'string' && /^[A-Za-z_$][\w$.]{0,60}$/.test(name) ? name : 'Error'
}

/** Scrub an error (or anything thrown) into the only shape a crash report may carry. */
export function scrubException(error: unknown): ScrubbedException {
  const source =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : typeof error === 'object' && error !== null
        ? (error as { name?: unknown; message?: unknown; stack?: unknown })
        : { name: 'Error', message: String(error), stack: undefined }
  const stack = typeof source.stack === 'string' ? source.stack : ''
  const frames = stack
    .split('\n')
    .map(frameOf)
    .filter((frame): frame is ScrubbedFrame => frame !== null)
    .slice(0, MAX_FRAMES)
  return {
    type: typeOf(source.name),
    value: scrubText(typeof source.message === 'string' ? source.message : ''),
    frames
  }
}
