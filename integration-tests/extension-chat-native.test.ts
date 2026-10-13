import { it, expect } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// Every case starts real Electron. Only the external model is a local HTTP test server.
for (const mode of ['PRO', 'FREE'] as const) {
  it.runIf(process.env.OFFGRID_NATIVE_DESKTOP_TEST === '1')(
    `uses the encrypted bridge and real chat/vault services with ${mode} access`,
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-native-chat-'))
      const output = path.resolve('coverage-native-desktop-raw')
      try {
        await fs.mkdir(output, { recursive: true })
        const compiled = path.join(output, `extension-chat-${mode.toLowerCase()}`)
        await promisify(execFile)(process.execPath, [
          'scripts/compile-native-desktop-test.mjs',
          compiled,
          'pro/main/__tests__/extension-chat-native.fixture.ts'
        ])
        const env = {
          ...process.env,
          OFFGRID_PRO: mode === 'PRO' ? '1' : '0',
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
          { env, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }
        )
        expect(result.stdout).toContain(`EXTENSION_CHAT_NATIVE_${mode}_PASSED`)
      } finally {
        await fs.rm(root, { recursive: true, force: true })
      }
    },
    75_000
  )
}
