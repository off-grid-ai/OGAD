// The user-facing name for the machine Off Grid runs on. macOS keeps the brand
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
