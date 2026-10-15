// The app's one engine updater, wired to the real settings, data folder and GPU check.
import { app } from 'electron'
import { createEngineUpdater } from './engine-updates'
import { getSetting, saveSetting } from './database'
import { dataDir } from './runtime-env'
import { hasLinuxNvidiaDriver, hasWindowsNvidiaDriver } from './transcription/whisper-runtime'

/** Setting key; engines stay current unless the user turns this off. */
const KEEP_ENGINES_UPDATED = 'keepEnginesUpdated'

export const engineUpdater = createEngineUpdater({
  platform: process.platform,
  dataDir,
  appVersion: () => app.getVersion(),
  enabled: () => getSetting<boolean>(KEEP_ENGINES_UPDATED, true) !== false,
  setEnabled: (enabled) => saveSetting(KEEP_ENGINES_UPDATED, enabled),
  hasGpu: () =>
    process.platform === 'win32'
      ? hasWindowsNvidiaDriver()
      : process.platform === 'linux' && hasLinuxNvidiaDriver(),
  packBin: () => process.env.OFFGRID_PERFORMANCE_PACK_BIN ?? null
})
