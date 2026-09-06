import { describe, expect, it, vi } from 'vitest'

const processBoundary = vi.hoisted(() => ({
  calls: [] as Array<{ file: string; args: string[]; options: Record<string, unknown> }>
}))

vi.mock('node:child_process', () => {
  const execFile = (): void => undefined
  Object.assign(execFile, {
    [Symbol.for('nodejs.util.promisify.custom')]: async (
      file: string,
      args: string[],
      options: Record<string, unknown>
    ) => {
      processBoundary.calls.push({ file, args, options })
      const script = args.at(-1) ?? ''
      if (script.includes('Get-StartApps')) {
        return {
          stdout: JSON.stringify([
            { Name: ' Notepad ', AppID: ' Microsoft.WindowsNotepad_8wekyb3d8bbwe!App ' },
            { Name: 'Missing identifier', AppID: ' ' }
          ]),
          stderr: ''
        }
      }
      if (script.includes('explorer.exe')) return { stdout: '', stderr: '' }
      if (script.includes('SetForegroundWindow')) return { stdout: '', stderr: '' }
      return { stdout: 'Notepad\r\n  Calculator  \r\n\r\n', stderr: '' }
    }
  })
  return { execFile }
})

describe('Windows native application adapter', () => {
  it('discovers, caches, launches, and activates applications through PowerShell', async () => {
    const { windowsNativeAppPlatform } = await import('../native-app-windows')

    await expect(windowsNativeAppPlatform.listRunning()).resolves.toEqual(['Notepad', 'Calculator'])
    const installed = await windowsNativeAppPlatform.listInstalled()
    expect(installed).toEqual([
      { id: 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', name: 'Notepad' }
    ])
    await expect(windowsNativeAppPlatform.listInstalled()).resolves.toBe(installed)

    await windowsNativeAppPlatform.launch(installed[0]!)
    await windowsNativeAppPlatform.activate(installed[0]!, 'Notepad')

    expect(processBoundary.calls).toHaveLength(4)
    expect(processBoundary.calls.every(({ file }) => file === 'powershell.exe')).toBe(true)
    expect(
      processBoundary.calls
        .filter(({ args }) => args.at(-1)?.includes('Get-StartApps'))
        .map(({ options }) => options.timeout)
    ).toEqual([6_000])
    expect(processBoundary.calls[2]?.args.at(-1)).toContain(
      'shell:AppsFolder\\Microsoft.WindowsNotepad_8wekyb3d8bbwe!App'
    )
    expect(processBoundary.calls[3]?.args.at(-1)).toContain("'Notepad'")
  })
})
