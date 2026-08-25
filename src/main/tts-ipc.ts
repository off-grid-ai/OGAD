import { ipcMain } from 'electron'
import { getSetting } from './database'
import { sampleProgressRate, type ProgressRateSample } from '@offgrid/ui'

/** Register the complete renderer-to-TTS contract in one place. The renderer sends text and an
 * optional voice; this owner resolves the persisted fallback and delegates synthesis to the active
 * TTS service. Keeping that composition out of the general IPC registry makes it independently
 * testable without duplicating voice-selection rules in a caller. */
export function setupTtsIpc(): void {
  const progressSender = (event: Electron.IpcMainInvokeEvent) => {
    let sample: ProgressRateSample | undefined
    return (progress: import('@offgrid/executorch-speech').DownloadProgress): void => {
      if (event.sender.isDestroyed()) return
      const measured = sampleProgressRate(sample, {
        currentBytes: progress.downloadedBytes,
        sampledAtMs: Date.now()
      })
      sample = measured.sample
      event.sender.send('tts:voice-progress', {
        voiceId: progress.voiceId,
        progress: progress.percentage,
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
        bytesPerSecond: measured.bytesPerSecond,
        currentAsset: progress.currentAsset
      })
    }
  }

  ipcMain.handle('tts:voices', async () => {
    const { listVoiceCatalog } = await import('./tts')
    try {
      return await listVoiceCatalog()
    } catch (error) {
      console.error('[tts] voices failed', error)
      return []
    }
  })

  ipcMain.handle('tts:prepare-voice', async (event, voice: string) => {
    const { prepareVoiceAssets } = await import('./tts')
    await prepareVoiceAssets(voice, progressSender(event))
    return { ready: true }
  })

  ipcMain.handle('tts:speak', async (event, text: string, voice?: string) => {
    const { synthesize } = await import('./tts')
    let chosenVoice = voice
    if (!chosenVoice) {
      try {
        chosenVoice = getSetting<string>('ttsVoice', '') || undefined
      } catch {
        /* synthesize owns the default voice when settings are unavailable */
      }
    }
    return synthesize(text, chosenVoice, progressSender(event))
  })
}
