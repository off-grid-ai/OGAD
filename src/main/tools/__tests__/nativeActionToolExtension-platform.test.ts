/**
 * Per-platform tool exposure (R2-A1): macOS ships the full set, Windows the
 * engine-routed Outlook subset, everywhere else nothing - and the model-
 * facing hint never promises a tool the platform does not expose.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  NATIVE_TOOL_SPECS,
  specsForPlatform,
  systemHintForPlatform,
  WINDOWS_TOOL_NAMES
} from '../nativeActionToolExtension-logic'
import {
  NativeActionToolExtension,
  registerNativeActionTools,
  type NativeActionToolBoundary
} from '../nativeActionToolExtension'

const boundary: NativeActionToolBoundary = {
  run: vi.fn(async () => ({ ok: true as const, result: {} })),
  proposeApproval: vi.fn(() => undefined),
  isProEntitled: () => true
}

describe('specsForPlatform', () => {
  it('darwin exposes the full set', () => {
    expect(specsForPlatform('darwin')).toHaveLength(NATIVE_TOOL_SPECS.length)
  })

  it('win32 exposes exactly the Outlook-routed subset', () => {
    expect(specsForPlatform('win32').map((s) => s.name).sort()).toEqual(
      [...WINDOWS_TOOL_NAMES].sort()
    )
  })

  it('any other platform exposes nothing', () => {
    expect(specsForPlatform('linux')).toEqual([])
  })
})

describe('systemHintForPlatform', () => {
  it('the Windows hint never mentions tools Windows does not have', () => {
    const hint = systemHintForPlatform('win32')
    expect(hint).toMatch(/Outlook/)
    expect(hint).not.toMatch(/iMessage|messages_send|contacts_search|calendar_list_events/)
  })

  it('the mac hint keeps the full vocabulary; unknown platforms get none', () => {
    expect(systemHintForPlatform('darwin')).toMatch(/messages_send/)
    expect(systemHintForPlatform('linux')).toBe('')
  })
})

describe('the extension on win32', () => {
  const extension = new NativeActionToolExtension(boundary, 'win32')

  it('schemas and canHandle follow the platform subset', () => {
    expect(extension.schemas()).toHaveLength(WINDOWS_TOOL_NAMES.size)
    expect(extension.canHandle('reminders_create')).toBe(true)
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

describe('registerNativeActionTools', () => {
  it('registers on darwin and win32, skips elsewhere', () => {
    for (const [platform, expected] of [
      ['darwin', 1],
      ['win32', 1],
      ['linux', 0]
    ] as const) {
      const register = vi.fn()
      registerNativeActionTools(register, platform)
      expect(register).toHaveBeenCalledTimes(expected)
    }
  })
})
