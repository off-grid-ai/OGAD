import { useEffect, useState } from 'react'
import { voice } from './voiceApi'

interface ShortcutProjection {
  accelerator: string | null
  registered: boolean | null
  message: string | null
}

function isSettingsRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function projectShortcut(
  settings: unknown
): Pick<ShortcutProjection, 'accelerator' | 'registered'> {
  if (!isSettingsRecord(settings)) {
    throw new Error('The settings response is invalid')
  }
  if (typeof settings.accelerator !== 'string' || !settings.accelerator.trim()) {
    throw new Error('The configured dictation shortcut is invalid')
  }
  if (typeof settings.shortcutRegistered !== 'boolean') {
    throw new Error('The shortcut registration result is invalid')
  }
  return {
    accelerator: settings.accelerator,
    registered: settings.shortcutRegistered
  }
}

/** Read the configured value and the active native registration result from its Pro owner. */
export function useDictationShortcut(enabled = true): ShortcutProjection {
  const [projection, setProjection] = useState<ShortcutProjection>({
    accelerator: null,
    registered: null,
    message: 'Reading configured shortcut...'
  })
  useEffect(() => {
    if (!enabled) return
    let active = true
    let generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = (): void => {
      const request = ++generation
      if (timer) clearTimeout(timer)
      void Promise.race([
        Promise.resolve().then(() => {
          const api = voice()
          if (!api) throw new Error('The dictation service is unavailable')
          return api.getSettings()
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Reading the configured shortcut timed out')),
            5_000
          )
        })
      ])
        .then((settings: unknown) => {
          if (!active || request !== generation) return
          setProjection({
            ...projectShortcut(settings),
            message: null
          })
        })
        .catch((error: unknown) => {
          if (!active || request !== generation) return
          console.error('[shortcut] Configured dictation shortcut could not be read', error)
          setProjection({
            accelerator: null,
            registered: null,
            message: 'Shortcut status unavailable. Open Voice to check it.'
          })
        })
        .finally(() => {
          if (request === generation && timer) clearTimeout(timer)
        })
    }
    read()
    window.addEventListener('focus', read)
    return () => {
      active = false
      generation += 1
      if (timer) clearTimeout(timer)
      window.removeEventListener('focus', read)
    }
  }, [enabled])
  return projection
}
