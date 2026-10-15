import type { SystemHealthComponentContract } from '../shared/ipc-contracts'
import { ffmpegBin } from './transcription/whisper-cli'
import { nativeBinaryInstalled } from './backend-facts'

interface NativeHelperOwner {
  id: string
  label: string
  resolve: () => string | null
}

// One-shot helpers are installed, not running. Each entry delegates to the same
// resolver used at the production spawn site; this registry only gives those
// runtime facts a stable System Health identity and label.
const NATIVE_HELPERS: readonly NativeHelperOwner[] = [
  { id: 'helper-ffmpeg', label: 'Audio decoder (ffmpeg)', resolve: ffmpegBin },
  {
    id: 'helper-whisper',
    label: 'Speech-to-text helper (whisper)',
    resolve: () => (nativeBinaryInstalled('stt', 'whisper-cli') ? 'whisper-cli' : null)
  }
]

export function getNativeHelperHealth(): SystemHealthComponentContract[] {
  return NATIVE_HELPERS.map((helper) => {
    const installed = helper.resolve() !== null
    return {
      id: helper.id,
      label: helper.label,
      status: installed ? 'installed' : 'not_installed',
      detail: installed ? 'Available on this device' : 'Bundled helper unavailable'
    }
  })
}
