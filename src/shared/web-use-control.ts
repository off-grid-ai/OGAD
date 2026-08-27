/** Single source of truth for Web Use browser-chrome shortcuts: the chords the
 * driver intercepts, the user-visible phrasing the model adapters see, and the
 * hint shown when a blocked chrome chord is refused. */
export type WebUseChromeCommand = 'back' | 'forward' | 'reload' | 'hard_reload'

export interface WebUseShortcutEntry {
  /** Human-readable action name, e.g. 'Back'. */
  label: string
  /** How the model is told to invoke it, e.g. 'ALT+LEFT'. */
  phrase: string
  /** Every accepted chord spelling; the first is the recommended one. */
  chords: readonly (readonly string[])[]
}

export const WEB_USE_SHORTCUTS: Record<WebUseChromeCommand, WebUseShortcutEntry> = {
  back: {
    label: 'Back',
    phrase: 'ALT+LEFT',
    chords: [
      ['alt', 'left'],
      ['cmd', '[']
    ]
  },
  forward: {
    label: 'Forward',
    phrase: 'ALT+RIGHT',
    chords: [
      ['alt', 'right'],
      ['cmd', ']']
    ]
  },
  reload: {
    label: 'Reload',
    phrase: 'CTRL+R or F5',
    chords: [['ctrl', 'r'], ['cmd', 'r'], ['f5']]
  },
  hard_reload: {
    label: 'Hard Reload',
    phrase: 'CTRL+SHIFT+R or CTRL+F5',
    chords: [
      ['ctrl', 'shift', 'r'],
      ['cmd', 'shift', 'r'],
      ['ctrl', 'f5'],
      ['shift', 'f5']
    ]
  }
}

/** Chrome chords that are invisible or unsafe inside the captured page. The
 * driver refuses them explicitly instead of leaking them as page key events. */
export const WEB_USE_BLOCKED_CHROME_CHORDS: readonly (readonly string[])[] = [
  ['f11'],
  ['f12'],
  ['shift', 'escape'],
  ...['ctrl', 'cmd'].flatMap((primary) =>
    ['l', 'w', 't', 'n', 'p', 's', 'o', 'u', 'j', 'h', 'd', 'f', '+', '-', '=', '0'].map((key) => [
      primary,
      key
    ])
  ),
  ...['ctrl', 'cmd'].flatMap((primary) =>
    ['i', 'j', 'c', 'b', 'n', 't'].map((key) => [primary, 'shift', key])
  ),
  ...Array.from({ length: 9 }, (_, index) => ['cmd', String(index + 1)]),
  ['ctrl', 'tab'],
  ['ctrl', 'shift', 'tab'],
  ['ctrl', 'pageup'],
  ['ctrl', 'pagedown']
]

const titleChord = (chord: readonly string[]): string =>
  chord.map((key) => key[0]!.toUpperCase() + key.slice(1)).join('+')

const recommendedChords = (
  ['back', 'forward', 'reload', 'hard_reload'] as const satisfies readonly WebUseChromeCommand[]
)
  .map((command) => titleChord(WEB_USE_SHORTCUTS[command].chords[0]!))
  .join(', ')

/** The recoverable-error hint shown when a blocked chrome chord is refused. */
export const WEB_USE_BLOCKED_CHROME_HINT = `That browser-chrome shortcut is not available in Web Use. Use Navigate, ${recommendedChords}, or visual page controls.`

/** Canonical control contract shown to every Web Use model adapter. */
export const WEB_USE_CONTROL_INSTRUCTIONS: readonly string[] = [
  'The screenshot contains the web page only. It has no native address bar, tab strip, or Developer Tools.',
  `Use ${WEB_USE_SHORTCUTS.back.phrase} for ${WEB_USE_SHORTCUTS.back.label} and ${WEB_USE_SHORTCUTS.forward.phrase} for ${WEB_USE_SHORTCUTS.forward.label}.`,
  `Use ${WEB_USE_SHORTCUTS.reload.phrase} for ${WEB_USE_SHORTCUTS.reload.label}. Use ${WEB_USE_SHORTCUTS.hard_reload.phrase} for ${WEB_USE_SHORTCUTS.hard_reload.label}.`,
  'Use a structured navigate action with an HTTPS URL to open a different website.',
  'Page keys are available: Tab, Shift+Tab, Enter, Escape, arrows, Home, End, Page Up, Page Down, Space, and normal editing or selection shortcuts.',
  'Never use Developer Tools, a JavaScript console, View Source, an address-bar shortcut, tab/window shortcuts, Print, Save, Downloads, History, Bookmarks, Find, Full Screen, or browser zoom.',
  'Use visual page controls instead of browser chrome. To leave an accidental detail page, use Back.'
]
