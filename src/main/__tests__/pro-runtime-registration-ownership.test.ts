import { describe, expect, it } from 'vitest'
import { callHook, registerHook, unregisterHook } from '../bootstrap/hookRegistry'
import {
  getToolExtensions,
  registerToolExtension,
  unregisterToolExtension,
  type ToolExtension
} from '../tools'

describe('Pro runtime registration ownership', () => {
  it('does not remove a hook that a newer owner replaced', () => {
    const name = 'test.pro-runtime-owned-hook'
    const first = (): string => 'first'
    const replacement = (): string => 'replacement'

    registerHook(name, first)
    registerHook(name, replacement)
    unregisterHook(name, first)

    expect(callHook(name)).toBe('replacement')
    unregisterHook(name, replacement)
    expect(callHook(name)).toBeUndefined()
  })

  it('does not remove an extension when a duplicate registration was not installed', () => {
    const id = 'test.pro-runtime-owned-extension'
    const extension = extensionWithId(id)
    const duplicate = extensionWithId(id)

    registerToolExtension(extension)
    registerToolExtension(duplicate)
    unregisterToolExtension(id, duplicate)

    expect(getToolExtensions()).toContain(extension)
    unregisterToolExtension(id, extension)
    expect(getToolExtensions()).not.toContain(extension)
  })
})

function extensionWithId(id: string): ToolExtension {
  return {
    id,
    schemas: () => [],
    canHandle: () => false,
    execute: () => ''
  }
}
