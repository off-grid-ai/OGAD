import { app } from 'electron'
import fs from 'node:fs'
import { join } from 'node:path'
import { beginProductIdentityBootstrap } from '../product-identity-lifecycle'
import { repairMissingDefaultKeychainAtBootstrap } from '../secure-storage-bootstrap'

let restoreProductName: (() => void) | null = null

function initializeUserData(): void {
  const security = repairMissingDefaultKeychainAtBootstrap(process.platform, app.isPackaged)
  if (security?.status === 'repaired') console.warn(`[secure-storage] ${security.detail}`)
  else if (security && security.status !== 'healthy') {
    console.error(`[secure-storage] ${security.detail}`)
  }

  restoreProductName = beginProductIdentityBootstrap(app, process.platform)

  if (process.env.OFFGRID_USER_DATA) {
    fs.mkdirSync(process.env.OFFGRID_USER_DATA, { recursive: true })
    app.setPath('userData', process.env.OFFGRID_USER_DATA)
    console.log('[userData] override path:', process.env.OFFGRID_USER_DATA)
    return
  }

  const appData = app.getPath('appData')
  const canonical = join(appData, 'Off Grid AI Desktop')
  fs.mkdirSync(canonical, { recursive: true })
  const move = (fromDir: string, name: string): void => {
    try {
      const source = join(fromDir, name)
      const destination = join(canonical, name)
      if (fs.existsSync(source) && !fs.existsSync(destination)) {
        fs.renameSync(source, destination)
      }
    } catch (error) {
      console.warn('[userData] migrate skip', name, error)
    }
  }
  move(join(appData, 'My Memories'), 'models')
  move(join(appData, 'my-memories'), 'models')
  move(join(appData, 'my-memories'), 'memories.db')
  move(join(appData, 'My Memories'), 'memories.db')
  app.setPath('userData', canonical)
  console.log('[userData] canonical path:', canonical)
}

try {
  initializeUserData()
} catch (error) {
  console.error('[userData] initialization failed', error)
  app.exit(1)
  throw error
}

/** Restore the visible product name after Electron finishes its secure-storage lookup. */
export function restoreCanonicalProductName(): void {
  if (!restoreProductName) throw new Error('User data was not initialized.')
  restoreProductName()
}
