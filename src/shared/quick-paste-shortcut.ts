import { isMac, shortcutLabel, type DevicePlatform } from './device'

/**
 * The clipboard quick paste shortcut. Ctrl+Shift+C is Copy in every Linux terminal (and Inspect in
 * Chromium), so a global grab there would break copying everywhere; Linux takes Ctrl+Alt+V instead.
 */
export function quickPasteAccelerator(platform: DevicePlatform): string {
  return platform === 'linux' ? 'Control+Alt+V' : 'CommandOrControl+Shift+C'
}

/** The quick paste shortcut as the person reads it. */
export function quickPasteLabel(platform: DevicePlatform): string {
  return isMac(platform) ? '⌘⇧C' : shortcutLabel(quickPasteAccelerator(platform), platform)
}

/** A launch that carries this opens quick paste in the running app (what a desktop shortcut runs). */
export const QUICK_PASTE_LAUNCH_ARG = '--action=clipboard-popup'

/** A second launch that asks the running app to do something, not to come to the front. */
export function isBackgroundLaunch(argv: readonly string[]): boolean {
  return argv.some((arg) => arg.startsWith('--action='))
}
