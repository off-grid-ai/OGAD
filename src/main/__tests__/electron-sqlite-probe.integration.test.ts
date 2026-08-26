import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PROBE = path.resolve(process.cwd(), 'scripts/probe-electron-sqlite.sh')

function runProbe(executable: '/usr/bin/true' | '/usr/bin/false'): {
  status: number | null
  stdout: string
} {
  const result = spawnSync('/bin/sh', [PROBE, '[pre-push]', executable], {
    encoding: 'utf8'
  })
  expect(result.stderr).toBe('')
  return { status: result.status, stdout: result.stdout.trim() }
}

describe('Electron SQLite restoration probe', () => {
  it('reports that Electron can load the restored native module', () => {
    expect(runProbe('/usr/bin/true')).toEqual({
      status: 0,
      stdout: '[pre-push] Electron ABI restored (app can load sqlite).'
    })
  })

  it('reports the exact rebuild action when Electron cannot load SQLite', () => {
    expect(runProbe('/usr/bin/false')).toEqual({
      status: 1,
      stdout:
        "[pre-push] WARNING: Electron cannot load sqlite - run 'npx electron-rebuild -f -w better-sqlite3-multiple-ciphers' before launching the app."
    })
  })
})
