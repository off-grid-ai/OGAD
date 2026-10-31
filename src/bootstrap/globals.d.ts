// Build-time flag injected by electron.vite.config.ts (define). True only when
// the private pro/ submodule is present at build time (pro build); false in the
// free/open build. Read by preload (isPro) and the main pro loader.
declare const __OFFGRID_PRO__: boolean
/** package.json's version, stamped into the main bundle at build time. */
declare const __OFFGRID_APP_VERSION__: string | undefined
/**
 * The `ui_action` ids found in source at build time (scripts/config/ui-action-ids.ts): every
 * `data-action`, `data-testid` and fixed `aria-label`, normalised. Main bundle only.
 */
declare const __OFFGRID_UI_ACTION_IDS__: readonly string[] | undefined
