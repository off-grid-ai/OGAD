import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { expect, it } from 'vitest'

// Only the compositor CLI is synthetic. The shipped Python helper runs as a real
// process and must return the exact focused window and valid screenshot bytes.
it.runIf(process.platform !== 'win32')(
  'captures and restores the exact Wayland window across focus changes',
  async () => {
    const { stderr } = await promisify(execFile)(
      process.platform === 'win32' ? 'python' : 'python3',
      [path.resolve('resources/linux-desktop/tests/window_contract.py')],
      { timeout: 15_000 }
    )
    expect(stderr).toContain('OK')
  },
  20_000
)
