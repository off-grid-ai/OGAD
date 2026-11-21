import type { FailureStep } from '@offgrid/failures'

/** Where a failure's step goes on desktop. The wording and the step come from @offgrid/failures. */
export function openFailureStep(step: Extract<FailureStep, { kind: 'open' }>): void {
  const navigate = (detail: unknown): void => {
    window.dispatchEvent(new CustomEvent('og:navigate', { detail }))
  }
  switch (step.target) {
    case 'models':
      navigate({ view: 'models', subroute: step.tab && step.tab !== 'vision' ? step.tab : 'text' })
      return
    case 'storage':
      navigate({ view: 'models', subroute: 'storage' })
      return
    case 'sync':
    case 'pairing':
      navigate({ view: 'devices' })
      return
    case 'integrations':
      navigate({ view: 'connectors' })
      return
    case 'microphone':
      void window.api.openMicrophoneSettings()
      return
    case 'permissions':
    case 'screen-recording':
    case 'app-settings':
      navigate({ view: 'settings', section: 'permissions' })
      return
    case 'upgrade':
      navigate({ view: 'settings', section: 'pro-plan' })
      return
  }
}
