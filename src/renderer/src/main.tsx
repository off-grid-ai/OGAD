import './assets/main.css'
import './assets/onboarding.css'
import { applyTheme } from './theme'
import { initFocusModality } from './lib/focus-modality'

// Apply the saved/system theme (dark default) before first paint.
applyTheme()

// Show the keyboard focus ring only for keyboard navigation, not on mouse click.
initFocusModality()

import { StrictMode, type FC } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { TooltipProvider } from './components/ui/tooltip'
import { attachSpeechPlaybackAdapter } from './composition/speech-playback-adapter'
import { attachSpeechMicrophoneAdapter } from './composition/speech-microphone-adapter'
import { attachSpeechTextCleaningAdapter } from './composition/speech-text-cleaning-adapter'

// The quick-paste popup is a Pro feature; its component lives in the pro package.
// The Vite alias resolves `@offgrid/pro/renderer` to a stub in free builds (which
// exports a no-op ClipboardPopup), and in free builds the popup window never opens.
import * as ProRenderer from '@offgrid/pro/renderer'
const ClipboardPopup: FC = (ProRenderer as { ClipboardPopup?: FC }).ClipboardPopup ?? (() => null)
const ComputerUseSupervisor: FC =
  (ProRenderer as { ComputerUseSupervisor?: FC }).ComputerUseSupervisor ?? (() => null)
// DictationOverlay is a free-tier / open-core feature — lives in core, not pro.
import { DictationOverlay } from './components/DictationOverlay'
// The Pro computer-use supervisor has its own surface so it can float over the
// app being driven. A free build resolves no component and renders nothing.

// The global-hotkey quick-paste popup, dictation overlay, and computer-use
// supervisor load this same renderer with a hash (#clip-popup / #dictation /
// #cu-supervisor); render just that surface there instead of the full app.
const hash = window.location.hash
const isClipPopup = hash === '#clip-popup'
const isDictation = hash === '#dictation'
const isCuSupervisor = hash === '#cu-supervisor'

if (!isClipPopup && !isDictation && !isCuSupervisor) {
  const disposeSpeechPlayback = attachSpeechPlaybackAdapter(window.api.speechPlayback)
  const disposeSpeechMicrophone = attachSpeechMicrophoneAdapter(window.api.speechMicrophone)
  const disposeSpeechTextCleaning = attachSpeechTextCleaningAdapter(window.api.speechTextCleaning)
  window.addEventListener(
    'pagehide',
    () => {
      disposeSpeechTextCleaning()
      disposeSpeechMicrophone()
      disposeSpeechPlayback()
    },
    { once: true }
  )
}

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
    ) : isCuSupervisor ? (
      <ComputerUseSupervisor />
    ) : (
      <TooltipProvider delayDuration={300}>
        <App />
      </TooltipProvider>
    )}
  </StrictMode>
)
