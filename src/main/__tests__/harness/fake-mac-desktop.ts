// A Mac desktop for Computer Use tests, at the app's real boundaries:
// - `text-extractor`, the Accessibility helper executable: `--apps`, `--elements <app>`,
//   `--default-browser` and `--set-slider-value`, read from and written to `desktop.json`;
// - `computer-use-capture`, the screen-capture helper executable, which writes the display image;
// - the macOS commands the app runs by absolute path (`/usr/bin/open`, `mdfind`, `mdls`,
//   `PlistBuddy`), through `macOsCommands`, for a test's `node:child_process` mock, so no real app
//   is ever opened.
// The input device is harness/fake-input-device.ts.
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type * as ChildProcess from 'node:child_process'

export interface DesktopElement {
  role: string
  label: string
  value?: string
  x: number
  y: number
  w: number
  h: number
  press?: boolean
  enabled?: boolean
}

export interface DesktopState {
  running: string[]
  installed: string[]
  windows: Record<string, { title: string; elements: DesktopElement[] }>
  /** What the helper and the OS were asked to do, oldest first. */
  log: string[]
}

const TEXT_EXTRACTOR = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const file = path.join(__dirname, 'desktop.json')
const state = JSON.parse(fs.readFileSync(file, 'utf8'))
const [command, app, ...rest] = process.argv.slice(2)
state.log.push([command, app, ...rest].filter((part) => part !== undefined).join(' '))
fs.writeFileSync(file, JSON.stringify(state))
if (command === '--apps') process.stdout.write(state.running.join('\\n') + '\\n')
else if (command === '--default-browser') process.stdout.write('{}')
else if (command === '--elements') {
  const window = state.windows[app]
  if (!window) process.exit(1)
  process.stdout.write('[WINDOW_TITLE] ' + window.title + '\\n')
  process.stdout.write('[WINDOW_CONTEXT] ' + JSON.stringify({ pid: 42, process: app, windowId: app + '-window', platformWindowId: 7, windowX: 0, windowY: 0, windowW: 800, windowH: 600, revision: state.log.length }) + '\\n')
  for (const element of window.elements) process.stdout.write(JSON.stringify({ value: '', enabled: true, press: true, ...element }) + '\\n')
} else if (command === '--set-slider-value') {
  // Sets nothing: this desktop has no slider owner. The request is in the log.
} else process.exit(2)
`

const CAPTURE = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
fs.copyFileSync(path.join(__dirname, 'display.png'), process.argv[2])
`

export interface FakeMacDesktop {
  binDir: string
  read(): DesktopState
  write(update: (state: DesktopState) => void): void
}

/** Install the helpers and an initial desktop under `binDir` (the app's OFFGRID_BIN_DIR). */
export async function installFakeMacDesktop(
  binDir: string,
  initial: Partial<DesktopState> = {}
): Promise<FakeMacDesktop> {
  fs.mkdirSync(binDir, { recursive: true })
  fs.writeFileSync(path.join(binDir, 'text-extractor'), TEXT_EXTRACTOR, { mode: 0o755 })
  fs.writeFileSync(path.join(binDir, 'computer-use-capture'), CAPTURE, { mode: 0o755 })
  const { default: sharp } = await import('sharp')
  await sharp({ create: { width: 800, height: 600, channels: 4, background: '#f4f4f4' } })
    .png()
    .toFile(path.join(binDir, 'display.png'))
  const file = path.join(binDir, 'desktop.json')
  const state: DesktopState = { running: [], installed: [], windows: {}, log: [], ...initial }
  fs.writeFileSync(file, JSON.stringify(state))
  const read = (): DesktopState => JSON.parse(fs.readFileSync(file, 'utf8')) as DesktopState
  return {
    binDir,
    read,
    write: (update) => {
      const next = read()
      update(next)
      fs.writeFileSync(file, JSON.stringify(next))
    }
  }
}

const OS_COMMANDS = new Set([
  '/usr/bin/open',
  '/usr/bin/mdfind',
  '/usr/bin/mdls',
  '/usr/libexec/PlistBuddy'
])

/** `node:child_process` with the macOS commands answered by the fake desktop in OFFGRID_BIN_DIR. */
export function macOsCommands(actual: typeof ChildProcess): typeof ChildProcess {
  const answer = (file: string, args: readonly string[]): string => {
    const desktopFile = path.join(process.env.OFFGRID_BIN_DIR ?? '', 'desktop.json')
    const state = JSON.parse(fs.readFileSync(desktopFile, 'utf8')) as DesktopState
    state.log.push([path.basename(file), ...args].join(' '))
    if (file === '/usr/bin/open') {
      const name = path.basename(args.at(-1) ?? '', '.app')
      if (!state.running.includes(name)) state.running.push(name)
    }
    fs.writeFileSync(desktopFile, JSON.stringify(state))
    if (file === '/usr/bin/mdfind')
      return state.installed.map((name) => `/Applications/${name}.app`).join('\0')
    return ''
  }
  const execFile = ((file: string, ...rest: unknown[]) => {
    if (!OS_COMMANDS.has(file))
      return (actual.execFile as (...a: unknown[]) => unknown)(file, ...rest)
    const args = (Array.isArray(rest[0]) ? rest[0] : []) as string[]
    const callback = rest.find((value) => typeof value === 'function') as
      ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    const stdout = answer(file, args)
    queueMicrotask(() => callback?.(null, stdout, ''))
    return undefined
  }) as unknown as typeof actual.execFile
  Object.defineProperty(execFile, promisify.custom, {
    value: (file: string, args: string[] = [], options?: unknown) =>
      OS_COMMANDS.has(file)
        ? Promise.resolve({ stdout: answer(file, args), stderr: '' })
        : (promisify(actual.execFile) as (...a: unknown[]) => Promise<unknown>)(file, args, options)
  })
  return { ...actual, execFile, default: { ...actual, execFile } } as typeof ChildProcess
}
