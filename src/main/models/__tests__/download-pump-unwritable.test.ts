// A download into a folder the app cannot write must end as a failure the person sees, not
// sit at 0% "downloading" forever. The part file's open fails (EACCES) while the network is
// still delivering; every later write is refused and the stream never drains, so a pump
// that waits for 'drain' after the error hangs, and Cancel cannot reach it either.
//
// Real Node write stream on a real read-only folder (the filesystem is the boundary); a
// byte reader stands in for the network body, slower than the failed open, as a real
// connection is.

import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { pumpToFile } from '../download-pump'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-pump-ro-'))
const READ_ONLY = path.join(TMP, 'models')
fs.mkdirSync(READ_ONLY)
fs.chmodSync(READ_ONLY, 0o555)
afterAll(() => {
  fs.chmodSync(READ_ONLY, 0o755)
  fs.rmSync(TMP, { recursive: true, force: true })
})

function slowNetwork(
  chunks: number,
  size: number
): { read(): Promise<{ done: boolean; value?: Uint8Array }> } {
  let sent = 0
  return {
    read: () =>
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve(
              sent++ < chunks
                ? { done: false, value: new Uint8Array(size).fill(1) }
                : { done: true }
            ),
          20
        )
      )
  }
}

describe('a download into a folder the app cannot write', () => {
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'fails with the folder error instead of waiting forever',
    async () => {
      const out = fs.createWriteStream(path.join(READ_ONLY, 'model.gguf.part'))
      await expect(pumpToFile(slowNetwork(20, 64 * 1024), out, () => {})).rejects.toThrow(
        /EACCES|permission/i
      )
      expect(fs.existsSync(path.join(READ_ONLY, 'model.gguf.part'))).toBe(false)
    },
    5000
  )
})
