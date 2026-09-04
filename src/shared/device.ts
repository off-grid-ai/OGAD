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
 * The modifier tokens Electron accepts in an accelerator, and the label to SHOW for each.
 *
 * Electron's registration vocabulary is not the vocabulary printed on the keys: it registers
 * `Alt`, and macOS labels that key Option. Anything not in this table is not a modifier - a key
 * name, a custom chord's own spelling - and is shown exactly as the setting spells it.
 *
 * Keys are lowercased so the two spellings Electron allows for one modifier (`Cmd`/`Command`,
 * `Ctrl`/`Control`) land on one label, and a setting that used the other casing still reads right.
 */
const MODIFIER_LABELS: Readonly<Record<string, (platform: DevicePlatform) => string>> = {
  commandorcontrol: primaryModifier,
  cmdorctrl: primaryModifier,
  command: () => 'Cmd',
  cmd: () => 'Cmd',
  control: () => 'Ctrl',
  ctrl: () => 'Ctrl',
  // The reported defect: 'Alt+Space' told Mac users to release a key their keyboard calls Option.
  alt: (platform) => (isMac(platform) ? 'Option' : 'Alt'),
  option: (platform) => (isMac(platform) ? 'Option' : 'Alt'),
  altgr: () => 'AltGr',
  shift: () => 'Shift',
  super: (platform) => (isMac(platform) ? 'Cmd' : 'Super'),
  meta: (platform) => (isMac(platform) ? 'Cmd' : 'Super')
}

/** One accelerator token as the user should read it. Non-modifiers are returned untouched. */
export function modifierLabel(token: string, platform: DevicePlatform): string {
  return MODIFIER_LABELS[token.toLowerCase()]?.(platform) ?? token
}

/**
 * An Electron accelerator as shortcut copy for this platform: `'Alt+Space'` -> `'Option+Space'`
 * on macOS, `'Alt+Space'` everywhere else.
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
