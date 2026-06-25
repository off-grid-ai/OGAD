// Auto-update via electron-updater + GitHub Releases. Checks on launch and every
// few hours; downloads in the background and installs on quit. A native
// notification fires when an update is downloaded (checkForUpdatesAndNotify).
import { autoUpdater } from 'electron-updater';
import { BrowserWindow } from 'electron';

export function startAutoUpdates(): void {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (e) => console.error('[update] error', e));
  autoUpdater.on('checking-for-update', () => console.log('[update] checking…'));
  autoUpdater.on('update-available', (i) => console.log('[update] available', i.version));
  autoUpdater.on('update-not-available', () => console.log('[update] up to date'));
  autoUpdater.on('update-downloaded', (i) => {
    console.log('[update] downloaded', i.version, '— will install on quit');
    BrowserWindow.getAllWindows().forEach((w) => w.webContents.send('update:downloaded', { version: i.version }));
  });

  const check = (): void => {
    autoUpdater.checkForUpdatesAndNotify().catch((e) => console.error('[update] check failed', e));
  };
  setTimeout(check, 10_000); // shortly after launch
  setInterval(check, 6 * 60 * 60 * 1000); // every 6 hours
}
