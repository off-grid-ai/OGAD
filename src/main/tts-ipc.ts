import { ipcMain } from 'electron'
import { getSetting } from './database'

/** Register the complete renderer-to-TTS contract in one place. The renderer sends text and an
 * optional voice; this owner resolves the persisted fallback and delegates synthesis to the active
 * TTS service. Keeping that composition out of the general IPC registry makes it independently
 * testable without duplicating voice-selection rules in a caller. */
export function setupTtsIpc(): void {
  ipcMain.handle('tts:voices', async (event) => {
    const { listVoiceCatalog } = await import('./tts')
    try {
      return await listVoiceCatalog((progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('tts:voice-progress', { progress })
      })
    } catch (error) {
      console.error('[tts] voices failed', error)
      return []
    }
  })

  ipcMain.handle('tts:speak', async (_event, text: string, voice?: string) => {
    const { synthesize } = await import('./tts')
    let chosenVoice = voice
    if (!chosenVoice) {
      try {
        chosenVoice = getSetting<string>('ttsVoice', '') || undefined
      } catch {
        /* synthesize owns the default voice when settings are unavailable */
      }
    }
    return synthesize(text, chosenVoice)
  })
}
