// Loads the private pro package's RENDERER features, if present. In the free
// build the Vite alias resolves `@offgrid/pro/renderer` to proStub (default
// null), so activateRenderer is absent and this is a no-op.

import { getRendererIsPro } from './entitlementRegistry'
import { clearRegisteredHooks, registerHook } from './hookRegistry'
import { clearRegisteredNav, registerNav } from './navRegistry'
import { clearProView, registerProView } from './proView'
import { clearRegisteredScreens, registerScreen } from './screenRegistry'
import { clearRegisteredSettingsSections, registerSettingsSection } from './sectionRegistry'
import { clearRegisteredSlots, registerSlot } from './slotRegistry'

export interface ProRendererApi {
  registerScreen: typeof registerScreen
  registerNav: typeof registerNav
  registerSlot: typeof registerSlot
  registerSettingsSection: typeof registerSettingsSection
  registerHook: typeof registerHook
  registerProView: typeof registerProView
}

export type ProRendererActivation = 'none' | 'entitlement-bootstrap' | 'full'

/** Remove every capability contributed by the private renderer package. This is
 * synchronous so a revoked entitlement cannot render or call one more paid
 * hook while React is changing screens. */
export function clearProFeaturesRenderer(): void {
  clearRegisteredNav()
  clearRegisteredScreens()
  clearRegisteredSlots()
  clearRegisteredSettingsSections()
  clearRegisteredHooks()
  clearProView()
}

export async function loadProFeaturesRenderer(): Promise<ProRendererActivation> {
  const bootstrapEnabled = Boolean(window.api?.proEntitlementBootstrapEnabled)
  let pro: unknown
  try {
    pro = await import('@offgrid/pro/renderer')
  } catch (error) {
    console.error('[pro] renderer package failed to load', error)
    return 'none' // free / contributor build
  }
  // Entitlement may change while the private chunk is loading. Read the live
  // renderer projection only after the await so a foreground revocation cannot
  // race a stale launch snapshot and register paid capabilities again.
  const entitled = getRendererIsPro()
  if (!entitled && bootstrapEnabled) {
    const activateBootstrap = (
      pro as {
        activateEntitlementBootstrapRenderer?: (api: ProRendererApi) => void
      }
    ).activateEntitlementBootstrapRenderer
    if (typeof activateBootstrap !== 'function') return 'none'
    try {
      clearProFeaturesRenderer()
      activateBootstrap(rendererApi)
      console.log('[pro] entitlement pairing renderer activated')
      return 'entitlement-bootstrap'
    } catch (e) {
      clearProFeaturesRenderer()
      console.error('[pro] activateEntitlementBootstrapRenderer failed', e)
      return 'none'
    }
  }
  if (!entitled) return 'none'
  const activateRenderer = (pro as { activateRenderer?: (api: ProRendererApi) => void })
    .activateRenderer
  if (typeof activateRenderer !== 'function') return 'none' // stub resolved to null
  try {
    clearProFeaturesRenderer()
    activateRenderer(rendererApi)
    console.log('[pro] renderer features activated')
    return 'full'
  } catch (e) {
    clearProFeaturesRenderer()
    console.error('[pro] activateRenderer failed', e)
    return 'none'
  }
}

const rendererApi: ProRendererApi = {
  registerScreen,
  registerNav,
  registerSlot,
  registerSettingsSection,
  registerHook,
  registerProView
}
