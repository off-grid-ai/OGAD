export const OPEN_MODEL_SETTINGS_PANEL_EVENT = 'og:open-model-settings-panel'
export type ModelSettingsPanelTab = 'model' | 'image' | 'voice' | 'tools' | 'connectors'

export function modelSettingsTabForKind(kind?: string): ModelSettingsPanelTab {
  if (kind === 'image') return 'image'
  if (kind === 'voice') return 'voice'
  return 'model'
}

export function supportsModelSettings(kind?: string): boolean {
  return kind === 'text' || kind === 'vision' || kind === 'image' || kind === 'voice'
}

/** Open the one shared model-settings drawer over the current screen. */
export function openModelSettingsPanel(tab: ModelSettingsPanelTab = 'model'): void {
  window.dispatchEvent(new CustomEvent(OPEN_MODEL_SETTINGS_PANEL_EVENT, { detail: { tab } }))
}
