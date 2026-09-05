/**
 * Real macOS application discovery and launch policy with only the operating-system process
 * boundary replaced. All inventory, identity, cache, and routing behavior stays in production.
 */
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
      if (file === '/fixture/ax-helper') {
        return { stdout: 'Safari\n WhatsApp \n\n', stderr: '' }
      }
      if (file === '/usr/bin/mdfind') {
        return {
          stdout:
            '/Applications/Safari.app\0/System/Applications/Notes.app\0/Applications/safari.app\0/tmp/readme.txt\0',
          stderr: ''
        }
      }
      if (file === '/usr/bin/mdls') {
        if (args.at(-1)?.endsWith('Notes.app')) throw new Error('Spotlight metadata unavailable')
        return { stdout: 'com.apple.Safari\n', stderr: '' }
      }
      if (file === '/usr/libexec/PlistBuddy') {
        return { stdout: 'com.apple.Notes\n', stderr: '' }
      }
      if (file === '/usr/bin/open') return { stdout: '', stderr: '' }
      throw new Error(`Unexpected process: ${file}`)
    }
  })
  return { execFile }
})

describe('macOS native application adapter', () => {
  it('discovers, identifies, caches, launches, and activates applications by stable identity', async () => {
    const { createMacNativeAppPlatform } = await import('../native-app-macos')
    const platform = createMacNativeAppPlatform('/fixture/ax-helper')

    await expect(platform.listRunning()).resolves.toEqual(['Safari', 'WhatsApp'])
    const installed = await platform.listInstalled()
    expect(installed).toEqual([
      { id: '/Applications/Safari.app', name: 'Safari', launchRef: '/Applications/Safari.app' },
      {
        id: '/System/Applications/Notes.app',
        name: 'Notes',
        launchRef: '/System/Applications/Notes.app'
      }
    ])
    await expect(platform.listInstalled()).resolves.toBe(installed)

    const safari = await platform.identify(installed[0]!)
    const notes = await platform.identify(installed[1]!)
    expect(safari.id).toBe('com.apple.Safari')
    expect(notes.id).toBe('com.apple.Notes')

    await platform.launch(safari)
    await platform.launch(installed[1]!)
    await platform.activate(safari, 'Safari')
    await platform.activate(installed[1]!, 'WhatsApp\u200e')

    expect(processBoundary.calls.filter(({ file }) => file === '/usr/bin/mdfind')).toHaveLength(1)
    expect(
      processBoundary.calls
        .filter(({ file }) => file === '/usr/bin/open')
        .map(({ args, options }) => ({ args, timeout: options.timeout }))
    ).toEqual([
      { args: ['-b', 'com.apple.Safari'], timeout: 5_000 },
      { args: ['/System/Applications/Notes.app'], timeout: 5_000 },
      { args: ['-b', 'com.apple.Safari'], timeout: 3_000 },
      { args: ['-a', 'WhatsApp\u200e'], timeout: 3_000 }
    ])
  })
})
