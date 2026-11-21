import { openModelsTab } from '@/lib/readiness-actions'

/** Asks chat to start in image mode. Chat may not be mounted yet, so the ask waits until it reads it. */
export const CHAT_IMAGE_MODE_EVENT = 'og:chat-image-mode'
let pending = false

/**
 * Opens chat in image mode, or Models on the Image tab when there is no image model. Either way the
 * screen is left through xdg-open - opens a file or URL in the user's preferred application

Synopsis

xdg-open { file | URL }

xdg-open { --help | --manual | --version }

Use 'man xdg-open' or 'xdg-open --manual' for additional info., so a caller that finishes on leaving (onboarding) still does.
 */
export async function openImageChat(open: (view: 'memory-chat' | 'models') => void): Promise<void> {
  let available = false
  try {
    available = Boolean((await window.api.imageGenStatus())?.available)
  } catch {
    available = false
  }
  if (!available) {
    open('models')
    openModelsTab('image')
    return
  }
  pending = true
  open('memory-chat')
  window.dispatchEvent(new Event(CHAT_IMAGE_MODE_EVENT))
}

/** Chat calls this on mount and on the event: true once, when image mode was asked for. */
export function takeImageModeRequest(): boolean {
  const asked = pending
  pending = false
  return asked
}
