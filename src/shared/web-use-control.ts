/**
 * TEMPORARY re-export shim (hexagonal program 2, seat C). Owner: `@offgrid/automation`
 * (`web-use-control`: the chrome shortcut table, blocked chords, the refusal hint, the model control
 * instructions). Delete when the vision model adapters (unowned) and `browser-driver.ts` import
 * `@offgrid/automation` directly.
 */
export {
  WEB_USE_SHORTCUTS,
  WEB_USE_BLOCKED_CHROME_CHORDS,
  WEB_USE_BLOCKED_CHROME_HINT,
  WEB_USE_CONTROL_INSTRUCTIONS,
  type WebUseChromeCommand,
  type WebUseShortcutEntry
} from '@offgrid/automation'
