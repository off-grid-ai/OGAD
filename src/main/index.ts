import { app, protocol } from 'electron'
import { guardConsoleStreams } from './stream-guards'
import { initializeUserData } from './bootstrap/user-data'

guardConsoleStreams([process.stdout, process.stderr])
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ogcapture',
    privileges: { secure: true, supportFetchAPI: true, bypassCSP: true, stream: true }
  },
  { scheme: 'ogartifact', privileges: { standard: true, secure: true, stream: true } }
])

// Static application imports can construct storage owners before this module body runs.
// Load them only after the canonical profile is established.
async function bootstrap(): Promise<void> {
  try {
    initializeUserData()
    await import('./application-main')
  } catch (error) {
    console.error('[startup] bootstrap failed', error)
    app.exit(1)
  }
}

void bootstrap()
