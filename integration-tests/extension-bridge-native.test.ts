import { it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// No UI automation: the fresh Electron process tests the real main-process transport.
it.runIf(process.env.OFFGRID_NATIVE_DESKTOP_TEST === '1')(
  'uses the persisted pairing over HTTP and revokes the live socket on unpair',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-native-bridge-'))
    const output = path.resolve('coverage-native-desktop-raw')
    try {
      await fs.mkdir(output, { recursive: true })
      const compiled = path.join(output, 'bridge')
      await promisify(execFile)(process.execPath, [
        'scripts/compile-native-desktop-test.mjs',
        compiled,
        'src/main/extension-bridge/__tests__/bridge-electron.fixture.ts'
      ])
      const env = {
        ...process.env,
        NODE_V8_COVERAGE: output,
        OFFGRID_DATA_DIR: path.join(root, 'data'),
        OFFGRID_NATIVE_PROFILE: root,
        OFFGRID_BIN_DIR: path.join(root, 'no-model-binaries')
      }
      delete env.ELECTRON_RUN_AS_NODE
      const args = process.platform === 'linux' ? ['--no-sandbox'] : []
      const result = await promisify(execFile)(
        require('electron') as string,
        [...args, path.join(compiled, 'main.cjs')],
        { env, timeout: 55_000, maxBuffer: 4 * 1024 * 1024 }
      )
      expect(result.stdout).toContain('EXTENSION_BRIDGE_NATIVE_PASSED')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  75_000
)
