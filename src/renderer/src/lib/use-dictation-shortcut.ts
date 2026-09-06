import { useEffect, useState } from 'react'
import { DEFAULT_DICTATION_ACCELERATOR } from '@offgrid/core/shared/dictation-defaults'

interface ShortcutProjection {
  accelerator: string | null
  message: string | null
}

/** Read-only configured value. This does not assert native hotkey registration or entitlement. */
export function useDictationShortcut(): ShortcutProjection {
  const [projection, setProjection] = useState<ShortcutProjection>({
    accelerator: null,
    message: 'Reading configured shortcut...'
  })
  useEffect(() => {
    let active = true
    let generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = (): void => {
      const request = ++generation
      if (timer) clearTimeout(timer)
      void Promise.race([
        Promise.resolve().then(() => window.api.getSettings()),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Reading the configured shortcut timed out')),
            5_000
          )
        })
      ])
        .then((settings: unknown) => {
          if (!active || request !== generation) return
          if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
            throw new Error('The settings response is invalid')
          }
          const value: unknown =
            'dictation:settings' in settings ? settings['dictation:settings'] : undefined
          if (
            value !== undefined &&
            (!value || typeof value !== 'object' || Array.isArray(value))
          ) {
            throw new Error('The saved dictation settings are invalid')
          }
          const accelerator =
            value && typeof value === 'object' && 'accelerator' in value
              ? value.accelerator
              : undefined
          if (accelerator !== undefined && typeof accelerator !== 'string') {
            throw new Error('The saved dictation shortcut is invalid')
          }
          setProjection({
            accelerator:
              typeof accelerator === 'string' && accelerator.trim()
                ? accelerator
                : DEFAULT_DICTATION_ACCELERATOR,
            message: null
          })
        })
        .catch((error: unknown) => {
          if (!active || request !== generation) return
          console.error('[shortcut] Configured dictation shortcut could not be read', error)
          setProjection({
            accelerator: null,
            message: 'Configured shortcut unavailable. Open Voice to check it.'
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
  }, [])
  return projection
}
