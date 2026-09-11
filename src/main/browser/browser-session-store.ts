/**
 * TEMPORARY re-export shim (hexagonal program 2, seat C). Owner: `@offgrid/automation`
 * (`browser-session-store`: one workspace per journey, active-then-root lookup, close reselects the
 * newest). Delete when `browser-host.ts` imports `@offgrid/automation` directly (C, with the
 * browser-host cutover) and the tests under `__tests__` are re-pointed.
 */
export { BrowserSessionStore, type BrowserSessionRecord } from '@offgrid/automation'
