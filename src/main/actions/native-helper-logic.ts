// Pure logic for the native actions helper invoker (no Electron, so it is unit
// testable). The Electron-bound wrapper in native-helper.ts resolves the binary and
// runs it; everything that can be reasoned about without spawning a process lives
// here: the command/response contract, binary-path candidates, and response parsing.

import path from 'path'

/** A command sent to the native helper: one namespaced action plus its arguments,
 *  e.g. { command: 'calendar.createEvent', args: { title, start, end } }. */
export interface NativeActionCommand {
  command: string
  args: Record<string, unknown>
}

/** The helper's reply. It always exits 0 and reports handled failures in-band, so a
 *  denied permission or a bad argument is a normal { ok: false } result, not a throw. */
export type NativeActionResponse = { ok: true; result: unknown } | { ok: false; error: string }

export function serializeCommand(cmd: NativeActionCommand): string {
  return JSON.stringify(cmd)
}

export interface HelperPathContext {
  isPackaged: boolean
  resourcesPath: string
  cwd: string
  appPath: string
}

/** Where the compiled helper can live, most-specific first. Packaged: bundled under
 *  Contents/Resources/bin (extraResources maps resources/ -> .). Dev: next to its
 *  source where build-actions-helper.sh emits it. Mirrors ocr.ts's resolution. */
export function helperBinCandidates(ctx: HelperPathContext): string[] {
  if (ctx.isPackaged) {
    return [
      path.join(ctx.resourcesPath, 'bin', 'actions-helper'),
      path.join(ctx.resourcesPath, 'actions-helper')
    ]
  }
  return [
    path.join(ctx.cwd, 'scripts', 'actions-helper', 'actions-helper'),
    path.join(ctx.appPath, 'scripts', 'actions-helper', 'actions-helper')
  ]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function truncate(text: string): string {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/** Parse the helper's stdout into a typed response. The helper prints one compact
 *  JSON line; we read the last non-empty line so a stray leading log line cannot
 *  break parsing. Any shape we do not recognize becomes an { ok: false } error
 *  rather than a throw, so a malformed helper degrades to a reported failure. */
export function parseHelperResponse(stdout: string): NativeActionResponse {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  const last = lines[lines.length - 1]
  if (!last) {
    return { ok: false, error: 'actions helper returned no output' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(last)
  } catch {
    return { ok: false, error: `actions helper returned invalid JSON: ${truncate(last)}` }
  }
  if (!isRecord(parsed)) {
    return { ok: false, error: 'actions helper returned a non-object response' }
  }
  if (parsed.ok === true) {
    return { ok: true, result: parsed.result }
  }
  if (parsed.ok === false) {
    const error =
      typeof parsed.error === 'string' ? parsed.error : 'actions helper reported an error'
    return { ok: false, error }
  }
  return { ok: false, error: 'actions helper returned an unrecognized response' }
}
