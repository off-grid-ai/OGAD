/**
 * The Electron-bound helper invoker, with its two true boundaries mocked:
 * electron (packaging context) and child_process (the spawned helper).
 * Covers what the dev/e2e paths cannot: candidate resolution misses, the
 * non-zero-exit-with-stdout salvage, and the spawn failure - each of which
 * must degrade to a reported { ok: false }, never a throw into the loop.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/fake/app' }
}))
vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('fs', async (importOriginal) => {
  const real = (await importOriginal()) as typeof import('fs')
  return { ...real, default: { ...real, existsSync: (p: string) => existingPaths.has(p) } }
})

let existingPaths = new Set<string>()

// promisify(execFile) consumes the callback-style mock; script it per-case.
type ExecCallback = (error: Error | null, result: { stdout: string; stderr: string }) => void
function scriptExec(behavior: (cmd: string) => { error?: Error & { stdout?: string }; stdout?: string }): void {
  execFileMock.mockImplementation(
    (bin: string, _args: string[], _opts: unknown, callback: ExecCallback) => {
      const out = behavior(bin)
      if (out.error) {
        callback(out.error, { stdout: out.error.stdout ?? '', stderr: '' })
        return
      }
      callback(null, { stdout: out.stdout ?? '', stderr: '' })
    }
  )
}

afterEach(() => {
  execFileMock.mockReset()
  existingPaths = new Set()
})

describe('runNativeAction', () => {
  it('reports helper-not-available when no candidate exists, without spawning', async () => {
    const { runNativeAction } = await import('../native-helper')
    const res = await runNativeAction({ command: 'reminders.list', args: {} })
    expect(res).toEqual({ ok: false, error: 'the native actions helper is not available in this build' })
    expect(execFileMock).not.toHaveBeenCalled()
  })

  it('runs the first existing candidate and parses its response', async () => {
    const { runNativeAction } = await import('../native-helper')
    existingPaths = new Set([`${process.cwd()}/scripts/actions-helper/actions-helper`])
    scriptExec(() => ({ stdout: '{"ok":true,"result":{"id":"r1"}}\n' }))
    const res = await runNativeAction({ command: 'reminders.create', args: { title: 'x' } })
    expect(res).toEqual({ ok: true, result: { id: 'r1' } })
  })

  it('salvages the response a dying helper printed before its non-zero exit', async () => {
    const { runNativeAction } = await import('../native-helper')
    existingPaths = new Set([`${process.cwd()}/scripts/actions-helper/actions-helper`])
    const error = Object.assign(new Error('exited 1'), {
      stdout: '{"ok":false,"error":"Reminders access denied"}\n'
    })
    scriptExec(() => ({ error }))
    const res = await runNativeAction({ command: 'reminders.list', args: {} })
    expect(res).toEqual({ ok: false, error: 'Reminders access denied' })
  })

  it('a spawn failure with no output degrades to the error message', async () => {
    const { runNativeAction } = await import('../native-helper')
    existingPaths = new Set([`${process.cwd()}/scripts/actions-helper/actions-helper`])
    scriptExec(() => ({ error: Object.assign(new Error('spawn EPERM'), { stdout: '' }) }))
    const res = await runNativeAction({ command: 'reminders.list', args: {} })
    expect(res).toEqual({ ok: false, error: 'spawn EPERM' })
  })
})
