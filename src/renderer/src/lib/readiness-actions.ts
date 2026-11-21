import type { ModelKind, PermissionKind, ReadinessAction } from '@offgrid/features'

/** The desktop Models tab for each shared model kind. */
const MODELS_TAB: Record<ModelKind, string> = {
  chat: 'text',
  vision: 'text',
  image: 'image',
  video: 'video',
  speech: 'transcription',
  voice: 'voice'
}

export function openModelsTab(kind: ModelKind): void {
  window.dispatchEvent(
    new CustomEvent('og:navigate', { detail: { view: 'models', subroute: MODELS_TAB[kind] } })
  )
}

/** The system Settings page for a permission; the in-app permissions list when there is none. */
export function openPermissionSettings(permission: PermissionKind): void {
  switch (permission) {
    case 'microphone':
      void window.api.openMicrophoneSettings()
      return
    case 'accessibility':
      void window.api.openAccessibilitySettings()
      return
    case 'screen-recording':
      void window.api.openScreenRecordingSettings()
      return
    case 'local-network':
      void window.api.openLocalNetworkSettings()
      return
    default:
      window.dispatchEvent(
        new CustomEvent('og:navigate', { detail: { view: 'settings', section: 'permissions' } })
      )
  }
}

export interface ReadinessHandlers {
  onRetry?: () => void
  /** Show the system prompt. Without it, Allow opens System Settings. */
  onAllow?: () => void
  /** Open the model picker. Without it, Choose model opens Models on the right tab. */
  onChoose?: () => void
  /** The Models tab for Choose model when there is no picker here. */
  chooseTab?: ModelKind
}

/** What a readiness step does on desktop. Undefined when the screen cannot do it (a retry with no handler). */
export function readinessHandler(
  action: ReadinessAction,
  handlers: ReadinessHandlers
): (() => void) | undefined {
  switch (action.kind) {
    case 'get-model':
      return () => openModelsTab(action.tab)
    case 'choose-model':
      return handlers.onChoose ?? (() => openModelsTab(handlers.chooseTab ?? 'chat'))
    case 'retry':
      return handlers.onRetry
    case 'allow':
      return handlers.onAllow ?? (() => openPermissionSettings(action.permission))
    case 'open-settings':
      return () => openPermissionSettings(action.permission)
  }
}
