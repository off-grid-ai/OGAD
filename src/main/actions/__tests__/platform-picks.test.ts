/**
 * The platform-pick seams, both arms each - so the one place an OS decides
 * an implementation is proven, not assumed.
 */
import { describe, expect, it } from 'vitest'
import { pickByPlatform } from '../use-runtime'
import { runNativeAction } from '../native-helper'
import { inlineRunnerForPlatform } from '../../tools/nativeActionToolExtension'

describe('pickByPlatform', () => {
  it('does not send Linux through a macOS or Windows implementation', () => {
    expect(pickByPlatform('win32', 'w', 'm', 'unsupported')).toBe('w')
    expect(pickByPlatform('darwin', 'w', 'm', 'unsupported')).toBe('m')
    expect(pickByPlatform('linux', 'w', 'm', 'unsupported')).toBe('unsupported')
  })
})

describe('inlineRunnerForPlatform', () => {
  it('darwin gets the Swift helper runner', () => {
    expect(inlineRunnerForPlatform('darwin')).toBe(runNativeAction)
  })

  it('win32 gets the shell runner: refuses non-links, reports opener failures', async () => {
    const run = inlineRunnerForPlatform('win32')
    expect(run).not.toBe(runNativeAction)
    const refused = await run({ command: 'reminders.list', args: {} })
    expect(refused.ok).toBe(false)
    // The opener arrow executes (electron's shell is inert under vitest), and
    // its failure degrades to a reported error - never a throw.
    const opened = await run({ command: 'system.openURL', args: {} })
    expect(opened.ok).toBe(false)
    if (!opened.ok) {
      expect(opened.error).toMatch(/could not open the link/)
    }
  })

  it('Linux does not run the macOS helper', async () => {
    const run = inlineRunnerForPlatform('linux')
    expect(run).not.toBe(runNativeAction)
    const result = await run({ command: 'reminders.list', args: {} })
    expect(result).toEqual({
      ok: false,
      error: 'native actions are not available on this platform'
    })
  })
})
