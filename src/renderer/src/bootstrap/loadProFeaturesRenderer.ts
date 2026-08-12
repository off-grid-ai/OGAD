// Loads the private pro package's RENDERER features, if present. In the free
// build the Vite alias resolves `@offgrid/pro/renderer` to proStub (default
// null), so activateRenderer is absent and this is a no-op.

import { registerScreen } from './screenRegistry'
import { registerNav } from './navRegistry'
import { registerSlot } from './slotRegistry'
import { registerSettingsSection } from './sectionRegistry'
import { registerHook } from './hookRegistry'
import { registerProView } from './proView'

export interface ProRendererApi {
  registerScreen: typeof registerScreen
  registerNav: typeof registerNav
  registerSlot: typeof registerSlot
  registerSettingsSection: typeof registerSettingsSection
  registerHook: typeof registerHook
  registerProView: typeof registerProView
}

export type ProRendererActivation = 'none' | 'entitlement-bootstrap' | 'full'

export async function loadProFeaturesRenderer(): Promise<ProRendererActivation> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entitled = Boolean((window as any).api?.isPro)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bootstrapEnabled = Boolean((window as any).api?.proEntitlementBootstrapEnabled)
  let pro: unknown
  try {
    pro = await import('@offgrid/pro/renderer')
  } catch {
    return 'none' // free / contributor build
  }
  if (!entitled && bootstrapEnabled) {
    const activateBootstrap = (
      pro as {
        activateEntitlementBootstrapRenderer?: (api: ProRendererApi) => void
      }
    ).activateEntitlementBootstrapRenderer
    if (typeof activateBootstrap !== 'function') return 'none'
    activateBootstrap({
      registerScreen,
      registerNav,
      registerSlot,
      registerSettingsSection,
      registerHook,
      registerProView
    })
    console.log('[pro] entitlement pairing renderer activated')
    return 'entitlement-bootstrap'
  }
  if (!entitled) return 'none'
  const activateRenderer = (pro as { activateRenderer?: (api: ProRendererApi) => void })
    .activateRenderer
  if (typeof activateRenderer !== 'function') return 'none' // stub resolved to null
  try {
    activateRenderer({
      registerScreen,
      registerNav,
      registerSlot,
      registerSettingsSection,
      registerHook,
      registerProView
    })
    console.log('[pro] renderer features activated')
    return 'full'
  } catch (e) {
    console.error('[pro] activateRenderer failed', e)
    return 'none'
  }
}
