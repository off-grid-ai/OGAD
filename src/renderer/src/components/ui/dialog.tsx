// Drop-in: this primitive now lives in @offgrid/operator-ui (src/hosts/ogad/ui/dialog.tsx)
// with the same exports and props. Edit it there, not here.
//
// OGAD-only wiring: native-surface occlusion is an app concern the library cannot
// import, so it is registered here, once, when this module loads. Every mounted
// DialogContent (including CommandDialog's) then acquires it when its node attaches
// and releases it when it detaches or unmounts - the same timing as before - so
// Electron's native child views stay below open dialogs.
//
// The same seam reports each open dialog as a screen for opt-in usage data: `dialog:<id>` from the
// content's fixed `data-testid` or `aria-label`, else `dialog` (lib/usage-tracker.ts).
import { registerDialogOcclusion } from '@offgrid/operator-ui/ogad/ui/dialog'
import { acquireNativeSurfaceOcclusion } from '@/lib/native-surface-occlusion'
import { openUsageOverlay, overlayScreenName } from '@/lib/usage-tracker'

registerDialogOcclusion(() => {
  const release = acquireNativeSurfaceOcclusion()
  // Called as the content node attaches, so the newest dialog content is this one.
  const contents = document.querySelectorAll('[data-slot="dialog-content"]')
  const close = openUsageOverlay(overlayScreenName('dialog', contents[contents.length - 1] ?? null))
  return () => {
    release()
    close()
  }
})

// eslint-disable-next-line react-refresh/only-export-components -- re-export shim; the components are defined in @offgrid/operator-ui
export * from '@offgrid/operator-ui/ogad/ui/dialog'
