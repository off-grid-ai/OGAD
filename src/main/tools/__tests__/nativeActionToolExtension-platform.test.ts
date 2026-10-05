/**
 * Per-platform tool exposure (R2-A1): macOS ships the full set, Windows the
 * engine-routed Outlook subset, Linux links - and the model-
 * facing hint never promises a tool the platform does not expose.
 */
import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: vi.fn() } }))
import {
  NATIVE_TOOL_SPECS,
  specsForPlatform,
  systemHintForPlatform,
  withWebUseTarget,
  WEB_USE_IN_DEFAULT_BROWSER_HINT,
  WINDOWS_TOOL_NAMES,
  LINUX_TOOL_NAMES
} from '../nativeActionToolExtension-logic'
import {
  NativeActionToolExtension,
  registerNativeActionTools,
  type NativeActionToolBoundary
} from '../nativeActionToolExtension'

const boundary: NativeActionToolBoundary = {
  run: vi.fn(async () => ({ ok: true as const, result: {} })),
  taskUseEnabled: () => true
}

describe('specsForPlatform', () => {
  it('darwin exposes the full set', () => {
    expect(specsForPlatform('darwin')).toHaveLength(NATIVE_TOOL_SPECS.length)
  })

  it('win32 exposes exactly the Outlook-routed subset', () => {
    expect(
      specsForPlatform('win32')
        .map((s) => s.name)
        .sort()
    ).toEqual([...WINDOWS_TOOL_NAMES].sort())
  })

  it('Linux exposes location and links without the watched workspace', () => {
    expect(
      specsForPlatform('linux')
        .map((spec) => spec.name)
        .sort()
    ).toEqual([...LINUX_TOOL_NAMES].sort())
    expect(specsForPlatform('linux', false).map((spec) => spec.name)).toEqual([
      'get_current_location',
      'open_url'
    ])
    expect(specsForPlatform('freebsd')).toEqual([])
  })
})

describe('systemHintForPlatform', () => {
  it('the Windows hint never mentions tools Windows does not have', () => {
    const hint = systemHintForPlatform('win32')
    expect(hint).toMatch(/Outlook/)
    expect(hint).not.toMatch(/iMessage|messages_send|contacts_search|calendar_list_events/)
  })

  it('the mac hint keeps the full vocabulary; Linux names only its tools', () => {
    const hint = systemHintForPlatform('darwin')
    expect(hint).toMatch(/messages_send/)
    expect(hint).toMatch(/requested in this Chat run directly/)
    expect(hint).not.toMatch(/pending until.*approve/i)
    expect(systemHintForPlatform('linux')).toMatch(/open_url/)
    expect(systemHintForPlatform('linux')).not.toMatch(/web_use/)
    expect(systemHintForPlatform('linux')).not.toMatch(/computer_use|calendar_create_event/)
    expect(systemHintForPlatform('freebsd')).toBe('')
  })
})

describe('the extension on win32', () => {
  const extension = new NativeActionToolExtension(boundary, 'win32')

  it('schemas and canHandle follow the platform subset', () => {
    expect(extension.schemas()).toHaveLength(WINDOWS_TOOL_NAMES.size)
    expect(extension.canHandle('reminders_create')).toBe(true)
    expect(extension.canHandle('get_current_location')).toBe(true)
    expect(extension.canHandle('messages_send')).toBe(false)
    expect(extension.canHandle('reminders_list')).toBe(false)
  })

  it('a mac-only tool is refused at execute even if the model hallucinates it', async () => {
    const reply = await extension.execute('messages_send', { to: 'x', text: 'hi' })
    expect(reply).toMatch(/unknown action/)
  })

  it('the hint matches the platform', () => {
    expect(extension.systemHint()).toMatch(/Outlook/)
  })
})

describe('the extension on Linux', () => {
  const extension = new NativeActionToolExtension(boundary, 'linux')

  it('offers location, links, and task tools in development builds', () => {
    expect(extension.canHandle('get_current_location')).toBe(true)
    expect(extension.canHandle('web_use')).toBe(true)
    expect(extension.canHandle('open_url')).toBe(true)
    expect(extension.canHandle('computer_use')).toBe(true)
    expect(extension.canHandle('calendar_create_event')).toBe(false)
    expect(extension.settings.map((spec) => spec.name)).toContain('computer_use')
    expect(extension.systemHint()).toContain('visible desktop apps')
  })

  it('does not offer task tools when the action runtime is absent', () => {
    const unavailable = new NativeActionToolExtension(
      { ...boundary, taskUseEnabled: () => false },
      'linux'
    )
    expect(unavailable.canHandle('computer_use')).toBe(false)
    expect(unavailable.canHandle('web_use')).toBe(false)
    expect(unavailable.canHandle('get_current_location')).toBe(true)
  })
})

describe('registerNativeActionTools', () => {
  it('registers on supported platforms only', () => {
    for (const [platform, expected] of [
      ['darwin', 1],
      ['win32', 1],
      ['linux', 1],
      ['freebsd', 0]
    ] as const) {
      const register = vi.fn()
      registerNativeActionTools(register, platform)
      expect(register).toHaveBeenCalledTimes(expected)
    }
  })
})

describe('withWebUseTarget', () => {
  it('tells the model web_use runs signed in when it runs in the default browser', () => {
    const hint = systemHintForPlatform('darwin')
    expect(withWebUseTarget(hint, false)).toBe(hint)
    expect(withWebUseTarget(hint, true)).toBe(`${hint} ${WEB_USE_IN_DEFAULT_BROWSER_HINT}`)
  })

  it('adds nothing where web_use is not offered', () => {
    const hint = systemHintForPlatform('darwin', false)
    expect(withWebUseTarget(hint, true)).toBe(hint)
  })
})
