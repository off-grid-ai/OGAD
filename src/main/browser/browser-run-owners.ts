/**
 * TEMPORARY re-export shim (hexagonal program 2, seat C). Owner: `@offgrid/automation`
 * (`browser-run-owners`: one live run per journey; a newer task halts and aborts the older run).
 * Desktop's guard type is bound here so `owner.guard` stays a VisionGuard for the host. Delete when
 * `browser-host.ts` imports `@offgrid/automation` directly and the test is re-pointed.
 */
import type { BrowserJourneyRunOwner as SharedBrowserJourneyRunOwner } from '@offgrid/automation'
import type { VisionGuard } from '../vision/vision-guard'

export { BrowserJourneyRunOwners } from '@offgrid/automation'
export type BrowserJourneyRunOwner = SharedBrowserJourneyRunOwner<VisionGuard>
