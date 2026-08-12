/**
 * License / Pro entitlement IPC.
 *
 * The renderer can't await the disk-backed license before it decides which tabs
 * to unlock, so the canonical gate lives in main and the renderer reads it two
 * ways:
 *  - `pro:is-enabled` (SYNC) — preload's `isPro`, read once at load via sendSync.
 *  - `license:changed` (push) — fired on activate/deactivate/revalidate so the UI
 *    can prompt a relaunch (main-process pro features only attach at boot).
 */
import { ipcMain, BrowserWindow, app, shell } from 'electron'
import { proEnabled, proEntitlementBootstrapEnabled } from './bootstrap/loadProFeaturesMain'
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

export function setupLicenseIpc(): void {
  // Push entitlement changes to every window so the UI can react / offer restart.
  setLicenseChangeNotifier((info: ProLicenseInfo) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('license:changed', info)
    }
  })

  // SYNC: preload reads this once to seed window.api.isPro. Must be registered
  // before the first window loads (it is — setupLicenseIpc runs before createWindow).
  ipcMain.on('pro:is-enabled', (e) => {
    e.returnValue = proEnabled()
  })
  ipcMain.on('pro:entitlement-bootstrap-enabled', (e) => {
    e.returnValue = proEntitlementBootstrapEnabled()
  })

  ipcMain.handle('license:status', () => getProLicenseInfo())
  ipcMain.handle('license:activate', (_e, key: string) => activateProByKey(key))
  ipcMain.handle('license:list-devices', () => listProDevices())
  ipcMain.handle('license:deactivate', (_e, machineId: string) => deactivateProDevice(machineId))
  ipcMain.handle('license:reset-current-device', () => resetProCurrentDevice())
  ipcMain.handle('license:clear', () => {
    clearPro()
  })
  ipcMain.handle('license:pay-url', () => PRO_PAY_PAGE_URL)
  ipcMain.handle('license:open-pay', () => shell.openExternal(PRO_PAY_PAGE_URL))
  // Pro main-process features (tray, capture, CRM loops) only attach at boot, so
  // a fresh activation needs a relaunch to fully light up.
  ipcMain.handle('license:relaunch', () => {
    requestApplicationRelaunch(app)
  })
}
