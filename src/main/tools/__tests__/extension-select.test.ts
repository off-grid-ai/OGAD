/**
 * The one rule for which extensions join an agentic turn: the assistant's
 * own tools always ride; connectors only when the user turned them on; an
 * undeclared category fails closed as a connector.
 */
import { describe, expect, it } from 'vitest'
import { selectToolExtensions } from '@offgrid/models'
import { nativeActionToolExtension } from '../nativeActionToolExtension'
import type { ToolExtension } from '../../tools'

const ext = (id: string, category?: 'tool' | 'connector'): ToolExtension => ({
  id,
  category,
  schemas: () => [],
  canHandle: () => false,
  execute: () => 'x'
})

describe('selectToolExtensions', () => {
  it("the assistant's own tools ride every agentic turn", () => {
    const picked = selectToolExtensions([ext('native', 'tool'), ext('mcp', 'connector')], {
      connectors: false
    })
    expect(picked.map((e) => e.id)).toEqual(['native'])
  })

  it('connectors join only when turned on', () => {
    const picked = selectToolExtensions([ext('native', 'tool'), ext('mcp', 'connector')], {
      connectors: true
    })
    expect(picked.map((e) => e.id)).toEqual(['native', 'mcp'])
  })

  it('an undeclared category fails closed as a connector', () => {
    const picked = selectToolExtensions([ext('legacy')], { connectors: false })
    expect(picked).toEqual([])
  })

  it('the native actions extension declares itself a tool', () => {
    expect(nativeActionToolExtension.category).toBe('tool')
  })
})
