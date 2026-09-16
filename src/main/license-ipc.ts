/**
 * License / Pro entitlement IPC.
 *
 * The renderer can't await the disk-backed license before it decides which tabs
 * to unlock, so the canonical gate lives in main and the renderer reads it two
 * ways:
 *  - `pro:is-enabled` (SYNC) — preload's `isPro`, read once at load via sendSync.
 *  - `license:changed` (push) — fired on activate/deactivate/revalidate and at a
 *    cached expiry deadline so the UI and paid runtime close in this session.
 */
import { ipcMain, BrowserWindow, app, shell } from 'electron'
import {
  deactivateProFeaturesMain,
  loadProFeaturesMain,
  proEnabled,
  proEntitlementBootstrapEnabled
} from './bootstrap/loadProFeaturesMain'
import { requestApplicationRelaunch } from './shutdown'
import {
  activateProByKey,
  deactivateProDevice,
  getProLicenseInfo,
  listProDevices,
  resetProCurrentDevice,
  clearPro,
  setLicenseChangeNotifier,
  PRO_PAY_PAGE_URL,
  type ProLicenseInfo
} from './licensing/license-service'
import { effectiveProLicenseInfo } from './licensing/effective-license'

export function setupLicenseIpc(): void {
  let licenseChangeRevision = 0
  let licenseChangeTask: Promise<void> = Promise.resolve()
  // Push entitlement changes to every window and stop live paid services when
  // access closes.
  setLicenseChangeNotifier((info: ProLicenseInfo) => {
    const revision = ++licenseChangeRevision
    const effectiveInfo = effectiveProLicenseInfo(info, proEnabled())
    const publish = (): void => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('license:changed', effectiveInfo)
      }
    }
    if (effectiveInfo.isPro) {
      licenseChangeTask = loadProFeaturesMain()
        .then(() => {
          if (revision === licenseChangeRevision) publish()
        })
        .catch(console.error.bind(console, '[pro] entitlement activation failed'))
      return
    }
    publish()
    licenseChangeTask = deactivateProFeaturesMain().catch(
      console.error.bind(console, '[pro] entitlement-loss shutdown failed')
    )
  })

  // SYNC: preload reads this once to seed window.api.isPro. Must be registered
  // before the first window loads (it is — setupLicenseIpc runs before createWindow).
  ipcMain.on('pro:is-enabled', (e) => {
    e.returnValue = proEnabled()
  })
  ipcMain.on('pro:entitlement-bootstrap-enabled', (e) => {
    e.returnValue = proEntitlementBootstrapEnabled()
  })

  ipcMain.handle('license:status', () => {
    const info = getProLicenseInfo()
    return effectiveProLicenseInfo(info, proEnabled())
  })
  ipcMain.handle('license:activate', async (_e, key: string) => {
    const result = await activateProByKey(key)
    await licenseChangeTask
    return result
  })
  ipcMain.handle('license:list-devices', () => listProDevices())
  ipcMain.handle('license:deactivate', (_e, machineId: string) => deactivateProDevice(machineId))
  ipcMain.handle('license:reset-current-device', () => resetProCurrentDevice())
  ipcMain.handle('license:clear', () => {
    clearPro()
  })
  ipcMain.handle('license:pay-url', () => PRO_PAY_PAGE_URL)
  ipcMain.handle('license:open-pay', () => shell.openExternal(PRO_PAY_PAGE_URL))
  // Kept for device-reset and update flows that still require a full process restart.
  ipcMain.handle('license:relaunch', () => {
    requestApplicationRelaunch(app)
  })
}
