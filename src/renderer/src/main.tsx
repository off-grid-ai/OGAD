import './assets/main.css'
import './assets/onboarding.css'
import { applyTheme, getThemeMode, onThemeModeChanged } from './theme'
import { applyUiAnimations, uiAnimationsOn, UI_ANIMATIONS_CHANGED } from './ui-animations'
import { initFocusModality } from './lib/focus-modality'
import { initScrollActivity } from './lib/scroll-activity'
import { cspNonce, initShadowStyleNonce } from './lib/shadow-style-nonce'

// Apply the saved/system theme (dark default) before first paint.
applyTheme()
applyUiAnimations()

// Media players style their shadow DOM with <style> tags; give them the CSP nonce.
initShadowStyleNonce()

// Show the keyboard focus ring only for keyboard navigation, not on mouse click.
initFocusModality()

// Scroll bars appear only while something scrolls (main.css paints them on data-scrolling).
initScrollActivity()

import { StrictMode, type FC } from 'react'
import { MotionConfig } from 'motion/react'
import { CSPProvider } from '@base-ui/react/csp-provider'
import { createRoot } from 'react-dom/client'
import { AliveProvider, LivingField } from '@offgrid/operator-ui/operator/alive'
import App from './App'
import { TooltipProvider } from './components/ui/tooltip'
import { AIRequestLogs } from './components/AIRequestLogs'

// The quick-paste popup is a Pro feature; its component lives in the pro package.
// The Vite alias resolves `@offgrid/pro/renderer` to a stub in free builds (which
// exports a no-op ClipboardPopup), and in free builds the popup window never opens.
import * as ProRenderer from '@offgrid/pro/renderer'
const ClipboardPopup: FC = (ProRenderer as { ClipboardPopup?: FC }).ClipboardPopup ?? (() => null)
// Ares on the desktop (God, Pro): nothing in a free build, where its window never opens.
const GodTwinCompanion: FC =
  (ProRenderer as { GodTwinCompanion?: FC }).GodTwinCompanion ?? (() => null)
const ComputerUseSupervisor: FC =
  (ProRenderer as { ComputerUseSupervisor?: FC }).ComputerUseSupervisor ?? (() => null)
// DictationOverlay is a free-tier / open-core feature — lives in core, not pro.
import { DictationOverlay } from './components/DictationOverlay'
import { installRendererErrorReporting, track } from './lib/analytics'
import { installUsageTracking } from './lib/usage-tracker'
// The Pro computer-use supervisor has its own surface so it can float over the
// app being driven. A free build resolves no component and renders nothing.

// The global-hotkey quick-paste popup, dictation overlay, and computer-use
// supervisor load this same renderer with a hash (#clip-popup / #dictation /
// #cu-supervisor); render just that surface there instead of the full app.
const hash = window.location.hash
const isClipPopup = hash === '#clip-popup'
const isDictation = hash === '#dictation'
const isCuSupervisor = hash === '#cu-supervisor'
const isGodTwin = hash === '#god-twin'

// The dictation overlay is a transparent floating panel — strip the app's opaque
// theme background off <html>/<body> so only the pill shows (no white box).
if (isDictation || isGodTwin) {
  document.documentElement.style.background = 'transparent'
  document.body.style.background = 'transparent'
  document.body.style.backgroundImage = 'none'
}

// Analytics are opt-in and off by default. The renderer only reports to the main process
// (src/main/analytics), which sends anonymous usage data and crash reports to PostHog after the
// user turns them on in setup, a prompt or Settings > Analytics. Chats and files never leave.
if (!isClipPopup && !isDictation && !isCuSupervisor && !isGodTwin) {
  installRendererErrorReporting()
  // Screens, fixed-id presses and scroll depth, counted by main into one summary per session.
  if (hash !== '#ai-activity') {
    installUsageTracking()
    // Theme and motion, for the daily snapshot.
    const reportAppearance = (): void =>
      track('appearance', { theme: getThemeMode(), ui_animations: uiAnimationsOn() })
    reportAppearance()
    onThemeModeChanged(reportAppearance)
    window.addEventListener(UI_ANIMATIONS_CHANGED, reportAppearance)
  }
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* popLayout exits pin themselves with a <style>; the CSP admits it only with the nonce. */}
    <MotionConfig nonce={cspNonce()}>
      {/* Base UI's popups (selects, menus) render <style> tags; same nonce. */}
      <CSPProvider nonce={cspNonce()}>
        {/* Starts the operator-ui alive conductor (pointer light, pulses) for every surface. */}
        <AliveProvider>
          {hash === '#ai-activity' ? (
            <TooltipProvider delayDuration={300}>
              <AIRequestLogs standalone />
            </TooltipProvider>
          ) : isClipPopup ? (
            <ClipboardPopup />
          ) : isDictation ? (
            <DictationOverlay />
          ) : isCuSupervisor ? (
            <ComputerUseSupervisor />
          ) : isGodTwin ? (
            <GodTwinCompanion />
          ) : (
            <>
              {/* The breathing background lives in the main window only; the floating
              overlays above stay transparent. */}
              <LivingField />
              <TooltipProvider delayDuration={300}>
                <App />
              </TooltipProvider>
            </>
          )}
        </AliveProvider>
      </CSPProvider>
    </MotionConfig>
  </StrictMode>
)
