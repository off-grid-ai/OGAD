import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { resourceFile } from './runtime-env'
import type { Result } from 'get-windows'

type FocusedWindow = Pick<Result, 'id' | 'title' | 'owner' | 'bounds'> & {
  token?: string
  url?: string
}

const execFileAsync = promisify(execFile)
const EXTENSION = 'offgrid-capture@getoffgridai.co'

export function isWaylandSession(): boolean {
  return (
    process.platform === 'linux' &&
    (process.env['XDG_SESSION_TYPE'] === 'wayland' ||
      (process.env['XDG_SESSION_TYPE'] !== 'x11' && !!process.env['WAYLAND_DISPLAY']))
  )
}

function nativeDirectory(): string {
  const helper = resourceFile('linux-desktop/desktop.py')
  if (!helper) throw new Error('The Linux desktop helper is missing from this installation.')
  return path.dirname(helper)
}

async function desktopCall<T>(operation: string, argument?: string | string[]): Promise<T> {
  const { stdout } = await execFileAsync(
    '/usr/bin/python3',
    [
      path.join(nativeDirectory(), 'desktop.py'),
      operation,
      ...(argument === undefined ? [] : Array.isArray(argument) ? argument : [argument])
    ],
    {
      timeout: operation === 'paste' ? 120_000 : 10_000,
      maxBuffer: 24 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${path.join(nativeDirectory(), 'bin')}:${process.env['PATH'] ?? ''}`
      }
    }
  )
  return JSON.parse(stdout) as T
}

/** Install the GNOME bridge only after capture was enabled by the user. */
export async function prepareLinuxCapture(): Promise<void> {
  if (!isWaylandSession() || !/gnome|ubuntu/i.test(process.env['XDG_CURRENT_DESKTOP'] ?? '')) return
  const target = path.join(
    process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local/share'),
    'gnome-shell/extensions',
    EXTENSION
  )
  const source = path.join(nativeDirectory(), EXTENSION)
  const extension = await fs.readFile(path.join(source, 'extension.js'), 'utf8')
  const metadata = await fs.readFile(path.join(source, 'metadata.json'), 'utf8')
  let current = ''
  let currentMetadata = ''
  try {
    current = await fs.readFile(path.join(target, 'extension.js'), 'utf8')
    currentMetadata = await fs.readFile(path.join(target, 'metadata.json'), 'utf8')
  } catch {
    /* first setup */
  }
  if (current !== extension || currentMetadata !== metadata) {
    await fs.mkdir(target, { recursive: true })
    await fs.copyFile(path.join(source, 'metadata.json'), path.join(target, 'metadata.json'))
    await fs.writeFile(path.join(target, 'extension.js'), extension)
  }
  try {
    await execFileAsync('gnome-extensions', ['enable', EXTENSION], { timeout: 5000 })
  } catch {
    throw new Error(
      'Enable Off Grid AI Capture in GNOME Extensions. If it is not listed, sign out of Linux and sign in once, then enable capture again.'
    )
  }
}

export async function readFocusedWindow(): Promise<FocusedWindow | undefined> {
  if (!isWaylandSession()) {
    const { activeWindow } = await import('get-windows')
    return activeWindow({ screenRecordingPermission: false, accessibilityPermission: false })
  }
  try {
    return (await desktopCall<FocusedWindow | null>('focus')) ?? undefined
  } catch (error) {
    throw new Error(
      'The Linux desktop could not provide the active window. Enable the Off Grid AI Capture desktop helper. ' +
        (error instanceof Error ? error.message : String(error))
    )
  }
}

export async function captureWaylandWindow(id: number): Promise<Buffer | null> {
  const captured = await desktopCall<{ png: string } | null>('capture', String(id))
  return captured?.png ? Buffer.from(captured.png, 'base64') : null
}

export async function activateWaylandWindow(token: string): Promise<boolean> {
  return desktopCall<boolean>('activate', token)
}

export async function pasteDesktopWindow(token: string, autoSend: boolean): Promise<boolean> {
  return desktopCall<boolean>('paste', [token, String(autoSend)])
}
