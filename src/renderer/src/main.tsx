import './assets/main.css'
import './assets/onboarding.css'
import { applyTheme } from './theme'

// Apply the saved/system theme (dark default) before first paint.
applyTheme()

import { StrictMode, type FC } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { TooltipProvider } from './components/ui/tooltip'

// The quick-paste popup is a Pro feature; its component lives in the pro package.
// The Vite alias resolves `@offgrid/pro/renderer` to a stub in free builds (which
// exports a no-op ClipboardPopup), and in free builds the popup window never opens.
import * as ProRenderer from '@offgrid/pro/renderer'
const ClipboardPopup: FC = (ProRenderer as { ClipboardPopup?: FC }).ClipboardPopup ?? (() => null)
// DictationOverlay is a free-tier / open-core feature — lives in core, not pro.
import { DictationOverlay } from './components/DictationOverlay'
import { registerPortableWorkspace } from './features/portable-workspace/register'

// The global-hotkey quick-paste popup and the dictation overlay load this same
// renderer with a hash (#clip-popup / #dictation); render just that surface there
// instead of the full app.
const hash = window.location.hash
const isClipPopup = hash === '#clip-popup'
const isDictation = hash === '#dictation'

if (!isClipPopup && !isDictation) registerPortableWorkspace()

// The dictation overlay is a transparent floating panel — strip the app's opaque
// theme background off <html>/<body> so only the pill shows (no white box).
if (isDictation) {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  document.body.style.backgroundImage = 'none'
}

// No analytics / telemetry. Off Grid AI is local-first — nothing leaves your device.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isClipPopup ? (
      <ClipboardPopup />
    ) : isDictation ? (
      <DictationOverlay />
    ) : (
      <TooltipProvider delayDuration={300}>
        <App />
      </TooltipProvider>
    )}
  </StrictMode>
)
