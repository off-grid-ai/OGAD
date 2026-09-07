/**
 * Real Windows accessibility adapter with only the PowerShell process boundary replaced. Script
 * construction, output normalization, AX parsing, timeouts, and fail-closed behavior stay real.
 */
import { describe, expect, it, vi } from 'vitest'

const powershell = vi.hoisted(() => ({
  fail: false,
  calls: [] as Array<{ args: string[]; options: Record<string, unknown> }>
}))

vi.mock('node:child_process', () => {
  const execFile = (): void => undefined
  Object.assign(execFile, {
    [Symbol.for('nodejs.util.promisify.custom')]: async (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => {
      expect(file).toBe('powershell.exe')
      powershell.calls.push({ args, options })
      if (powershell.fail) throw new Error('PowerShell unavailable')
      const script = args.at(-1) ?? ''
      if (script.includes('GetSupportedPatterns')) {
        return {
          stdout: [
            '[WINDOW_TITLE] Notes - Work',
            '{"role":"Button","label":"Save","x":100,"y":40,"w":80,"h":30,"press":true,"enabled":true}',
            '{"role":"Edit","label":"Body","value":"private note","x":20,"y":90,"w":500,"h":300,"press":false,"enabled":true}'
          ].join('\n'),
          stderr: ''
        }
      }
      return { stdout: ' Notes \r\nCalculator\n\n', stderr: '' }
    }
  })
  return { execFile }
})

describe('Windows accessibility adapter', () => {
  it('normalizes native application output, parses a snapshot, and fails closed', async () => {
    const { windowsAxBackend } = await import('../ax-win')

    expect(windowsAxBackend.available()).toBe(process.platform === 'win32')
    await expect(windowsAxBackend.listApps()).resolves.toEqual(['Notes', 'Calculator'])
    await expect(windowsAxBackend.snapshot("Notes team's board")).resolves.toMatchObject({
      windowTitle: 'Notes - Work',
      elements: [
        { index: 1, role: 'Button', name: 'Save', cx: 140, cy: 55, actionable: true },
        {
          index: 2,
          role: 'Edit',
          name: 'Body',
          value: 'private note',
          cx: 270,
          cy: 240,
          actionable: false
        }
      ]
    })

    expect(powershell.calls[0]).toMatchObject({
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        expect.any(String)
      ],
      options: { timeout: 4_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }
    })
    expect(powershell.calls[1]?.args.at(-1)).toContain("$target = 'Notes team''s board'")
    expect(powershell.calls[1]?.options.timeout).toBe(6_000)

    powershell.fail = true
    await expect(windowsAxBackend.listApps()).resolves.toEqual([])
    await expect(windowsAxBackend.snapshot('Notes')).resolves.toBeNull()
  })
})
