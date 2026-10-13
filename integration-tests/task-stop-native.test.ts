import { it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

it.runIf(process.env.OFFGRID_NATIVE_DESKTOP_TEST === '1')(
  'keeps a stopped browser task terminal after its action engine finishes',
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-task-stop-'))
    const compiled = path.resolve('coverage-native-desktop-raw/task-stop')
    try {
      await promisify(execFile)(process.execPath, [
        'scripts/compile-native-desktop-test.mjs',
        compiled,
        'src/main/__tests__/task-stop-native.fixture.ts'
      ])
      const env = {
        ...process.env,
        OFFGRID_NATIVE_PROFILE: root,
        OFFGRID_DATA_DIR: path.join(root, 'data'),
        OFFGRID_BIN_DIR: path.join(root, 'no-model-binaries'),
        OFFGRID_PRO: '0',
        OFFGRID_AUTO_APPROVE: '1'
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
      expect(result.stdout, result.stderr).toContain('TASK_STOP_NATIVE_PASSED')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  },
  45000
)
