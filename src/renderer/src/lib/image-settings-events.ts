export const IMAGE_SETTINGS_CHANGED_EVENT = 'og:image-settings-changed'

export function announceImageSettingsChanged(): void {
  window.dispatchEvent(new CustomEvent(IMAGE_SETTINGS_CHANGED_EVENT))
}
