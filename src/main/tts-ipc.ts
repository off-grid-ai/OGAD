import { ipcMain } from 'electron'
import { getSetting } from './database'
import { writeDiagnosticLog } from './diagnostics-log'

/** Register the complete renderer-to-TTS contract in one place. The renderer sends text and an
 * optional voice; this owner resolves the persisted fallback and delegates synthesis to the active
 * TTS service. Keeping that composition out of the general IPC registry makes it independently
 * testable without duplicating voice-selection rules in a caller. */
export function setupTtsIpc(): void {
  /**
   * Forward one download observation. Main measures nothing.
   *
   * It used to compute `bytesPerSecond` here with `sampleProgressRate` from `@offgrid/ui` - the
   * main process reaching into a presentation package for arithmetic. A transfer speed is a
   * presentation number: it exists to be rendered next to a bar, the renderer already formats it
   * with `formatTransferSpeed`, and nothing in main reads it. So main sends what it OBSERVES -
   * bytes and when they were counted - and the surface that shows the rate derives it, from the
   * package that legitimately owns it.
   */
  const progressSender = (event: Electron.IpcMainInvokeEvent) => {
    return (progress: import('@offgrid/executorch-speech').DownloadProgress): void => {
      if (event.sender.isDestroyed()) return
      event.sender.send('tts:voice-progress', {
        voiceId: progress.voiceId,
        progress: progress.percentage,
        downloadedBytes: progress.downloadedBytes,
        totalBytes: progress.totalBytes,
        sampledAtMs: Date.now(),
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
      throw error
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
      } catch (error) {
        // The synthesis owner can safely choose its default, but the persistence outage must remain
        // observable instead of looking like an intentional user selection.
        writeDiagnosticLog(
          'tts',
          'voice_setting_read_failed',
          { error: error instanceof Error ? error.message : String(error) },
          'error'
        )
      }
    }
    return synthesize(text, chosenVoice, progressSender(event))
  })
}
