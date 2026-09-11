/**
 * The Electron main-process `app` boundary for gateway integration tests.
 *
 * `scripts/vitest-electron-node.mjs` runs vitest under `ELECTRON_RUN_AS_NODE=1`, where
 * `require('electron')` resolves to the npm launcher (a binary path), not the runtime API - so
 * `import { app } from 'electron'` yields `undefined` and any production read such as
 * `app.isPackaged` throws. Electron is a true process boundary we cannot run in-process, so each
 * suite that boots the real gateway supplies this stub via
 * `vi.mock('electron', () => import('./harness/electron-app-boundary').then((m) => m.electronAppBoundary()))`.
 *
 * `userData` points at a throwaway directory so the real `mcp-auth` token persistence writes its
 * owner-only token file there, never into a developer profile. Callers may remove it in `afterAll`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ELECTRON_STUB_USER_DATA = fs.mkdtempSync(
  path.join(os.tmpdir(), 'offgrid-electron-app-boundary-')
)

export function electronAppBoundary(): {
  app: {
    getPath: (name: string) => string
    isPackaged: boolean
    getAppPath: () => string
    getVersion: () => string
  }
} {
  return {
    app: {
      getPath: () => ELECTRON_STUB_USER_DATA,
      isPackaged: false,
      getAppPath: () => process.cwd(),
      getVersion: () => 'test'
    }
  }
}
