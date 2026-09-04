// The dictation hotkey's DEFAULT, owned in one place.
//
// Five copies of `'Alt+Space'` existed - the onboarding tour and Pro catalogue (both OPEN build),
// the dictation overlay, the Voice screen, and the registering controller in `pro/` - so the string
// the app advertised and the string it registered were only coincidentally equal. This module lives
// in `src/shared/` because the open build cannot import from the private Pro submodule while Pro
// imports `@offgrid/core/shared/*` freely; that constraint is why the copies existed.
//
// This owns WHAT the default chord is. `./device.ts` owns how a chord is SPELLED.

/**
 * The chord registered when the user has not chosen their own, in Electron's ACCELERATOR format.
 * Never show it raw - pass it through `shortcutLabel` or `shortcutSymbols` from `./device.ts`, or a
 * Windows/Linux reader is told to hold a key their keyboard has no name for. A surface that can read
 * the user's CONFIGURED accelerator shows that instead and uses this only as the fallback.
 */
export const DEFAULT_DICTATION_ACCELERATOR = 'Alt+Space'

/**
 * The same chord as the macOS push-to-talk helper needs it. The helper watches raw key events, so it
 * cannot consume the accelerator string: these are a separate encoding of one chord (49 = Space,
 * `option` = the key Electron spells `Alt`), kept literal rather than derived. Change them together
 * with the accelerator, or the advertised copy and the watched key disagree.
 */
export const DEFAULT_DICTATION_KEY_CODE = 49
export const DEFAULT_DICTATION_MODIFIER = 'option'
