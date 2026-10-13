import { it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

it.runIf(process.env.OFFGRID_NATIVE_DESKTOP_TEST === '1')(
  'preserves model failures and visual fallback reasons through the real Web Use host',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-web-failure-'))
    const compiled = path.resolve('coverage-native-desktop-raw/web-use-failure')
    try {
      await promisify(execFile)(process.execPath, [
        'scripts/compile-native-desktop-test.mjs',
        compiled,
        'src/main/__tests__/web-use-failure-native.fixture.ts'
      ])
      const env = {
        ...process.env,
        OFFGRID_NATIVE_PROFILE: root,
        OFFGRID_DATA_DIR: path.join(root, 'data'),
        OFFGRID_BIN_DIR: path.join(root, 'no-model-binaries'),
        OFFGRID_PRO: '0'
      }
      delete env.ELECTRON_RUN_AS_NODE
      const result = await promisify(execFile)(
        require('electron') as string,
        [
          ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
          path.join(compiled, 'main.cjs')
        ],
        { env, timeout: 30000, maxBuffer: 1024 * 1024 }
      )
      expect(result.stdout).toContain('WEB_USE_FAILURE_NATIVE_PASSED')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  45000
)
