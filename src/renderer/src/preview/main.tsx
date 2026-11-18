// The translation preview: the real desktop screens in a plain browser, for the translate editor
// (off-grid-ai-translate.vercel.app). UI only: the demo bridge answers every main-process call with a fixed
// value, so nothing loads and nothing is saved. Analytics, the floating overlays and the popup windows of
// main.tsx are left out.
//
//   preview.html?lang=de&route=/settings   a screen in German (route: any path the app's router knows)
//
// The editor (in the parent frame) sends { type: 'offgrid-i18n', locale, strings } as a person types; the
// screen redraws with the new text. Standalone, ?lang= loads catalogs/<code>/{common,desktop}.json beside
// this page.
import '../assets/main.css'
import '../assets/onboarding.css'
import { StrictMode } from 'react'
import { MotionConfig } from 'motion/react'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { createRoot } from 'react-dom/client'
import { AliveProvider, LivingField } from '@offgrid/operator-ui/operator/alive'
import { applyTheme } from '../theme'
import { applyUiAnimations } from '../ui-animations'
import { initFocusModality } from '../lib/focus-modality'
import { cspNonce, initShadowStyleNonce } from '../lib/shadow-style-nonce'
import { replaceAppLocation } from '../lib/app-location'
import { createDemoApi } from './demo-api'
import { Preview } from './Preview'

;(window as unknown as { api: unknown }).api = createDemoApi()
applyTheme()
applyUiAnimations()
initShadowStyleNonce()
initFocusModality()

const params = new URLSearchParams(window.location.search)
const route = params.get('route')
// route=/onboarding shows first run; every other route opens the app as a person who finished it.
try {
  if (route === '/onboarding') localStorage.removeItem('onboarding_completed')
  else localStorage.setItem('onboarding_completed', 'true')
} catch {
  // No storage (a private window): the app shows first run, which is still a screen to translate.
}
if (route?.startsWith('/') && route !== '/onboarding') replaceAppLocation(route)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionConfig nonce={cspNonce()}>
      <CSPProvider nonce={cspNonce()}>
        <AliveProvider>
          <LivingField />
          <Preview />
        </AliveProvider>
      </CSPProvider>
    </MotionConfig>
  </StrictMode>
)
