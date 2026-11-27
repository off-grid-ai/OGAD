import { translate } from '@offgrid/i18n'
import {
  deviceNoun as nounForPlatform,
  isMac as isMacForPlatform,
  primaryModifier as modifierForPlatform,
  shortcutLabel as shortcutLabelForPlatform,
  type DevicePlatform
} from '@offgrid/core/shared/device'

// Renderer-side convenience over the shared device rules. Resolves the platform
// from the value the preload bridge exposes (`window.api.platform`) so callers
// don't thread it through. Falls back to a non-Mac label ('device' / not-Mac) if
// the bridge value is missing, so copy + gating degrade safely rather than throw.

/** The current platform as seen by the renderer (single source for the wrappers). */
export function currentPlatform(): DevicePlatform {
  if (typeof window === 'undefined') return 'unknown'
  const bridge = (window as unknown as { api?: { platform?: DevicePlatform | null } }).api
  return bridge?.platform ?? 'unknown'
}

/**
 * The user-facing name for this machine, including its platform when known, in the app language. Put it in
 * a whole sentence with t('… {0} …', deviceNoun()), never between JSX text pieces.
 */
export function deviceNoun(opts?: { capitalize?: boolean }): string {
  return translate(nounForPlatform(currentPlatform(), opts))
}

/** True when running on macOS. The device flag for platform-gating Pro features. */
export function isMac(): boolean {
  return isMacForPlatform(currentPlatform())
}

/** The primary modifier label for shortcut copy ('Cmd' on macOS, else 'Ctrl'). */
export function primaryModifier(): string {
  return modifierForPlatform(currentPlatform())
}

/**
 * A registered Electron accelerator as the user reads it: 'Alt+Space' shows as 'Option+Space' on
 * macOS. Naming only - it never changes which keys are registered, and a customized chord keeps
 * its own tokens and their order.
 */
export function shortcutLabel(accelerator: string): string {
  return shortcutLabelForPlatform(accelerator, currentPlatform())
}
