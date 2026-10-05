import { it, expect } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

it('preserves Core and Pro source counts when a native report moves between runners', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'offgrid-coverage-paths-'))
  const file = path.join(directory, 'coverage-final.json')
  const entry = (name: string): Record<string, unknown> => ({
    path: name,
    statementMap: { 0: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } },
    fnMap: {},
    branchMap: {},
    s: { 0: 3 },
    f: {},
    b: {}
  })
  const core = path.resolve('src/main/extension-bridge/bridge-http.ts')
  const pro = path.resolve('pro/main/capture.ts')
  const fixture = path.resolve('src/main/extension-bridge/__tests__/bridge-electron.fixture.ts')
  try {
    await fs.writeFile(
      file,
      JSON.stringify({ [core]: entry(core), [pro]: entry(pro), [fixture]: entry(fixture) })
    )
    await promisify(execFile)(process.execPath, [
      'scripts/normalize-native-coverage.mjs',
      file,
      'relative'
    ])
    const transferred = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(Object.keys(transferred).sort()).toEqual([
      'pro/main/capture.ts',
      'src/main/extension-bridge/bridge-http.ts'
    ])
    await promisify(execFile)(process.execPath, [
      'scripts/normalize-native-coverage.mjs',
      file,
      'absolute'
    ])
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      [core]: entry(core),
      [pro]: entry(pro)
    })
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
