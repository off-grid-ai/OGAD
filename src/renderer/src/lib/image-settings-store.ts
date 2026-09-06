import type { ImageParamStore } from './image-params'

/**
 * What an image setting change tells the rest of the app: the settings that were committed, and
 * only those. A consumer applies what it is given and never goes back to read everything.
 */
export interface ImageSettingsProjection {
  readonly imageParams?: ImageParamStore
  readonly imgSeed?: string
  readonly imgNegative?: string
  readonly enhanceImagePrompts?: boolean
}

export type ImageSettingKey = keyof ImageSettingsProjection

type SettingsListener = (committed: ImageSettingsProjection) => void

const settingsListeners = new Set<SettingsListener>()
const modelListeners = new Set<() => void>()

/** Announce a committed image-setting change to whoever renders it. */
export function publishImageSettings(committed: ImageSettingsProjection): void {
  for (const listener of settingsListeners) listener(committed)
}

export function subscribeImageSettings(listener: SettingsListener): () => void {
  settingsListeners.add(listener)
  return () => {
    settingsListeners.delete(listener)
  }
}

/**
 * The active image model is owned by the model control plane, not by these preferences, so it
 * travels on its own channel: a preference change must not make anyone re-read engine status.
 */
export function publishActiveImageModelChanged(): void {
  for (const listener of modelListeners) listener()
}

export function subscribeActiveImageModel(listener: () => void): () => void {
  modelListeners.add(listener)
  return () => {
    modelListeners.delete(listener)
  }
}
