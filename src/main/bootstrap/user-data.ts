import { app } from 'electron'
import fs from 'node:fs'
import { join } from 'node:path'
import { beginProductIdentityBootstrap } from '../product-identity-lifecycle'
import { repairMissingDefaultKeychainAtBootstrap } from '../secure-storage-bootstrap'

let restoreName: (() => void) | null = null

/** Must finish before importing any application owner that can read a profile path. */
export function initializeUserData(): void {
  if (restoreName) throw new Error('User data was already initialized.')
  const security = repairMissingDefaultKeychainAtBootstrap(process.platform, app.isPackaged)
  if (security?.status === 'repaired') console.warn(`[secure-storage] ${security.detail}`)
  else if (security && security.status !== 'healthy')
    console.error(`[secure-storage] ${security.detail}`)
  restoreName = beginProductIdentityBootstrap(app, process.platform)
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
      const src = join(fromDir, name)
      const dst = join(canonical, name)
      if (fs.existsSync(src) && !fs.existsSync(dst)) fs.renameSync(src, dst)
    } catch (error) {
      console.warn('[userData] migrate skip', name, error)
    }
  }
  move(join(appData, 'My Memories'), 'models')
  move(join(appData, 'my-memories'), 'models')
  move(join(appData, 'my-memories'), 'memories.db')
  move(join(appData, 'My Memories'), 'memories.db')
  app.setPath('userData', canonical)
}

export function restoreCanonicalProductName(): void {
  if (!restoreName) throw new Error('User data bootstrap has not completed.')
  restoreName()
}
