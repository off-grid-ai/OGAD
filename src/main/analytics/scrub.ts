import os from 'node:os'

/**
 * Crash scrubbing (docs/ANALYTICS.md, Crashes): replace paths with the file name only, drop any
 * quoted text, keep type, file name, line and function. URLs, hosts, IP addresses and e-mail
 * addresses are on the never-send list too, so they go as well.
 *
 * File and document names are on the never-send list, so a path in a message keeps its name only
 * when it is the app's own code (`index.js`); a person's file becomes `<file>`. The home folder
 * and the account name go first, because they can hold spaces a path pattern cannot see.
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
// The patterns below are not linear on hostile input, so no pattern ever sees more than this.
const MAX_INPUT_CHARS = 2_000
const MAX_FRAME_LINE_CHARS = 1_000

const QUOTED = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’/g
const URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g
const IPV4 = /\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi
// A Windows path (C:\..., \\server\share\...) or a POSIX path with at least two segments.
const WINDOWS_PATH = /(?:[a-z]:\\|\\\\|~\\)[^\s:*?"<>|]*/gi
const POSIX_PATH = /(?:~|\.{1,2})?\/(?:[^\s/:]+\/)+[^\s/:]*/g
// A domain name that is not a file name: something.tld with a letters-only TLD.
const HOST =
  /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|co|dev|app|local|lan|internal|me|uk|de|fr|in|eu|us)\b/gi

// The app's own code: its file name helps find the bug and names nothing of the person's.
const CODE_FILE = /\.(?:[cm]?[jt]sx?|node|asar|dylib|so|dll|exe|wasm)$/i
// A bare file name a person owns: a document, media, an archive or a model file.
const USER_FILE =
  /[^\s/\\:<>"'`]+\.(?:pdf|docx?|xlsx?|pptx?|txt|md|csv|tsv|json|rtf|pages|key|numbers|html?|png|jpe?g|gif|heic|webp|svg|mp3|m4a|wav|ogg|mp4|mov|mkv|zip|gguf|safetensors|onnx|bin)\b/gi

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

let account: { home: RegExp | null; user: RegExp | null } | undefined

/** The home folder and the account name of this computer, read once. */
function accountPatterns(): { home: RegExp | null; user: RegExp | null } {
  if (account) return account
  let home = ''
  let user = ''
  try {
    home = os.homedir()
    user = os.userInfo().username
  } catch {
    /* no account information: the path patterns still apply */
  }
  account = {
    home: home.length > 1 ? new RegExp(escapeRegExp(home), 'gi') : null,
    // A very short account name would match inside ordinary words.
    user: user.length >= 3 ? new RegExp(`\\b${escapeRegExp(user)}\\b`, 'gi') : null
  }
  return account
}

/** A path in free text: the app's own code file keeps its name; anything else is `<file>`. */
function fileOnly(path: string): string {
  const name = baseName(path)
  return CODE_FILE.test(name) ? name : '<file>'
}

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).at(-1) ?? ''
}

/** Scrub one free-text value (an error message or a function name). */
/**
 * Cut over-long text before any pattern runs. A quote the cut leaves open would escape the quote
 * rule, so the text is also cut at that quote.
 */
function bounded(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text
  let value = text.slice(0, MAX_INPUT_CHARS)
  // One cut can open a quote of another kind, so cut until every kind is closed.
  for (let cut = openQuoteAt(value); cut >= 0; cut = openQuoteAt(value)) value = value.slice(0, cut)
  return value
}

/** Where the last unclosed quote starts, or -1 when every quote is closed. */
function openQuoteAt(value: string): number {
  for (const mark of ['"', "'", '`']) {
    if (value.split(mark).length % 2 === 0) return value.lastIndexOf(mark)
  }
  for (const [open, close] of [
    ['“', '”'],
    ['‘', '’']
  ] as const) {
    if (value.lastIndexOf(open) > value.lastIndexOf(close)) return value.lastIndexOf(open)
  }
  return -1
}

export function scrubText(text: string): string {
  const { home, user } = accountPatterns()
  let value = bounded(text)
    .replace(QUOTED, '<redacted>')
    .replace(URL, '<url>')
    .replace(EMAIL, '<email>')
  // Under the home folder a path is the person's own, and it can hold spaces: drop it to the
  // next separator.
  if (home) value = value.replace(home, '~').replace(/~[\\/][^,;()\n]*/g, '<file>')
  if (user) value = value.replace(user, '<user>')
  return value
    .replace(WINDOWS_PATH, fileOnly)
    .replace(POSIX_PATH, fileOnly)
    .replace(USER_FILE, '<file>')
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
  if (line.length > MAX_FRAME_LINE_CHARS) return null
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
