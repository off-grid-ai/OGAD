import { openModelsTab } from '@/components/ReadinessNotice'

/** Asks chat to start in image mode. Chat may not be mounted yet, so the ask waits until it reads it. */
export const CHAT_IMAGE_MODE_EVENT = 'og:chat-image-mode'
let pending = false

/** Opens chat in image mode, or Models on the Image tab when there is no image model. */
export async function openImageChat(openChat: () => void): Promise<void> {
  const status = await window.api.imageGenStatus().catch(() => null)
  if (!status?.available) {
    openModelsTab('image')
    return
  }
  pending = true
  openChat()
  window.dispatchEvent(new Event(CHAT_IMAGE_MODE_EVENT))
}

/** Chat calls this on mount and on the event: true once, when image mode was asked for. */
export function takeImageModeRequest(): boolean {
  const asked = pending
  pending = false
  return asked
}
