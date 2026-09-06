/**
 * Renderer-local invalidation signals for settings whose canonical value is owned by main.
 *
 * These events intentionally carry no value. A subscriber always reads the committed setting
 * through preload, so Settings and Chat cannot become two competing state owners.
 */
export const LLM_SETTINGS_INVALIDATED_EVENT = 'og:llm-settings-invalidated'
export const DISPLAY_SETTINGS_INVALIDATED_EVENT = 'og:display-settings-invalidated'

export function invalidateLlmSettings(): void {
  window.dispatchEvent(new Event(LLM_SETTINGS_INVALIDATED_EVENT))
}

export function invalidateDisplaySettings(): void {
  window.dispatchEvent(new Event(DISPLAY_SETTINGS_INVALIDATED_EVENT))
}
