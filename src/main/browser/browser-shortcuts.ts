import type { Input } from 'electron'
import type { BrowserChromeCommand } from '../../shared/browser-library'

/** What a browser keyboard shortcut does. Chrome's keys, per platform. */
export type BrowserShortcut =
  | { kind: 'new-tab' }
  | { kind: 'close-tab' }
  | { kind: 'reopen-closed-tab' }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'reload'; hard: boolean }
  | { kind: 'devtools' }
  | { kind: 'print' }
  | { kind: 'bookmark' }
  | { kind: 'next-tab' }
  | { kind: 'previous-tab' }
  | { kind: 'chrome'; command: BrowserChromeCommand }

type KeyInput = Pick<Input, 'type' | 'key' | 'code' | 'meta' | 'control' | 'alt' | 'shift'>

export function browserShortcut(input: KeyInput, platform: string): BrowserShortcut | null {
  if (input.type !== 'keyDown') return null
  const mac = platform === 'darwin'
  const mod = mac ? input.meta && !input.control : input.control && !input.meta
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key
  if (key === 'F12' || (mod && input.alt && (key === 'i' || input.code === 'KeyI'))) {
    return { kind: 'devtools' }
  }
  if (key === 'F5') return { kind: 'reload', hard: input.shift || (!mac && input.control) }
  if (input.alt && !mod && key === 'ArrowLeft') return { kind: 'back' }
  if (input.alt && !mod && key === 'ArrowRight') return { kind: 'forward' }
  if (!mod || input.alt) return null
  if (input.shift) {
    if (key === 't') return { kind: 'reopen-closed-tab' }
    if (key === 'r') return { kind: 'reload', hard: true }
    if (key === 'b') return { kind: 'chrome', command: 'bookmarks' }
    if (mac && key === 'j') return { kind: 'chrome', command: 'downloads' }
    if (key === '[' || key === '{') return { kind: 'previous-tab' }
    if (key === ']' || key === '}') return { kind: 'next-tab' }
    return null
  }
  switch (key) {
    case 't':
      return { kind: 'new-tab' }
    case 'w':
      return { kind: 'close-tab' }
    case 'r':
      return { kind: 'reload', hard: false }
    case '[':
      return { kind: 'back' }
    case ']':
      return { kind: 'forward' }
    case 'l':
      return { kind: 'chrome', command: 'focus-address' }
    case 'f':
      return { kind: 'chrome', command: 'find' }
    case 'd':
      return { kind: 'bookmark' }
    case 'p':
      return { kind: 'print' }
    case 'y':
      return mac ? { kind: 'chrome', command: 'history' } : null
    case 'h':
      return mac ? null : { kind: 'chrome', command: 'history' }
    case 'j':
      return mac ? null : { kind: 'chrome', command: 'downloads' }
    case 'Tab':
      return { kind: 'next-tab' }
    default:
      return null
  }
}
