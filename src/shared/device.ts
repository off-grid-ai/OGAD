// The user-facing name for the machine Off Grid AI runs on. macOS keeps the brand
// name "Mac"; every other platform (Windows, Linux, anything else) gets the
// neutral "device". Single source of truth so copy never drifts between the
// main process and the renderer — both call this instead of hardcoding "Mac".
//
// Pure + dependency-free (no electron, no node/DOM) so it loads in every bundle
// and is unit-testable. Callers pass the platform: `process.platform` in main,
// the preload-bridged value in the renderer (see src/renderer/src/lib/device.ts).

export type DevicePlatform = NodeJS.Platform | string

/**
 * Noun to show the user for their computer.
 * - macOS (`'darwin'`) -> `'Mac'` (proper noun, always capitalized)
 * - Windows / Linux / anything else -> `'device'`
 *
 * Pass `{ capitalize: true }` for sentence- or heading-initial use so `'device'`
 * becomes `'Device'` (no effect on `'Mac'`, which is already capitalized).
 */
export function deviceNoun(platform: DevicePlatform, opts?: { capitalize?: boolean }): string {
  const noun = platform === 'darwin' ? 'Mac' : 'device'
  if (opts?.capitalize) {
    return noun.charAt(0).toUpperCase() + noun.slice(1)
  }
  return noun
}

/**
 * The device flag: true on macOS. Use this to gate features that are only
 * confirmed working on Mac — the Pro layer is macOS-tested only for now, so on
 * Windows/Linux we show Pro subscribers a "coming soon" screen instead of the
 * untested feature (see proCatalog.proFeatureComingSoon).
 */
export function isMac(platform: DevicePlatform): boolean {
  return platform === 'darwin'
}

/**
 * The primary keyboard modifier label for the platform, for showing shortcuts in
 * copy: `'Cmd'` on macOS, `'Ctrl'` everywhere else. Mirrors Electron's
 * `CommandOrControl` accelerator (which maps to ⌘ on Mac, Ctrl on Windows/Linux),
 * so a hotkey described in the UI matches the key the app actually registers.
 * Single source of truth so shortcut copy never drifts between platforms.
 */
export function primaryModifier(platform: DevicePlatform): string {
  return isMac(platform) ? 'Cmd' : 'Ctrl'
}

/**
 * The modifier tokens Electron accepts in an accelerator, and how to SHOW each one.
 *
 * Electron's registration vocabulary is not the vocabulary printed on the keys: it registers
 * `Alt`, and macOS labels that key Option and draws it as the glyph on the keycap. Anything not in
 * this table is not a modifier - a key name, a custom chord's own spelling - and is shown exactly
 * as the setting spells it.
 *
 * `label` is the word, for prose and for platforms with no glyph vocabulary; `symbol` is what
 * macOS prints. One table, two renderings: the fact of WHICH modifier a token names is answered
 * here and nowhere else, so no surface has to re-derive it to print it its own way.
 *
 * Keys are lowercased so the two spellings Electron allows for one modifier (`Cmd`/`Command`,
 * `Ctrl`/`Control`) land on one answer, and a setting that used the other casing still reads right.
 */
interface ModifierRule {
  readonly label: (platform: DevicePlatform) => string
  /** The glyph macOS prints on the key. Absent where the key has none. */
  readonly symbol?: string
}

const MODIFIERS: Readonly<Record<string, ModifierRule>> = {
  commandorcontrol: { label: primaryModifier, symbol: '\u2318' },
  cmdorctrl: { label: primaryModifier, symbol: '\u2318' },
  command: { label: () => 'Cmd', symbol: '\u2318' },
  cmd: { label: () => 'Cmd', symbol: '\u2318' },
  control: { label: () => 'Ctrl', symbol: '\u2303' },
  ctrl: { label: () => 'Ctrl', symbol: '\u2303' },
  // The reported defect: 'Alt+Space' told Mac users to release a key their keyboard calls Option.
  alt: { label: (platform) => (isMac(platform) ? 'Option' : 'Alt'), symbol: '\u2325' },
  option: { label: (platform) => (isMac(platform) ? 'Option' : 'Alt'), symbol: '\u2325' },
  altgr: { label: () => 'AltGr' },
  shift: { label: () => 'Shift', symbol: '\u21e7' },
  super: { label: (platform) => (isMac(platform) ? 'Cmd' : 'Super'), symbol: '\u2318' },
  meta: { label: (platform) => (isMac(platform) ? 'Cmd' : 'Super'), symbol: '\u2318' }
}

/** One accelerator token as a word. Non-modifiers are returned untouched. */
export function modifierLabel(token: string, platform: DevicePlatform): string {
  return MODIFIERS[token.toLowerCase()]?.label(platform) ?? token
}

/**
 * An Electron accelerator as shortcut copy for this platform: `'Alt+Space'` -> `'Option+Space'`
 * on macOS, `'Alt+Space'` everywhere else. For prose, where a glyph reads badly mid-sentence
 * ("release Option+Space to stop") and where the platform may have no glyphs at all.
 *
 * Naming only. It does not parse, validate, reorder or re-register anything, so a customized
 * shortcut survives token for token and in its own order - `'Ctrl+Shift+K'` still reads as
 * itself. Same single source of truth as `primaryModifier`, which it reuses for
 * `CommandOrControl`, so what the UI prints cannot drift from the key that was registered.
 */
export function shortcutLabel(accelerator: string, platform: DevicePlatform): string {
  return accelerator
    .split('+')
    .map((token) => modifierLabel(token, platform))
    .join('+')
}

/**
 * The same accelerator in macOS keycap glyphs, space separated: `'Alt+Space'` -> `'⌥ Space'`.
 * For a `<kbd>` or a shortcut chip, where the glyphs are what the keyboard actually shows.
 *
 * Off macOS this falls back to the word form, because ⌥ and ⌘ name nothing on a Windows or
 * Linux keyboard. Non-modifier tokens keep their own spelling either way.
 */
export function shortcutSymbols(accelerator: string, platform: DevicePlatform): string {
  if (!isMac(platform)) return shortcutLabel(accelerator, platform)
  return accelerator
    .split('+')
    .map((token) => MODIFIERS[token.toLowerCase()]?.symbol ?? modifierLabel(token, platform))
    .join(' ')
}
