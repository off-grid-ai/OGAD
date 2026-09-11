import { describe, it, expect } from 'vitest'
import {
  isMemoryToolAllowed,
  KNOWLEDGE_BASE_TOOL_ID as KB_TOOL_NAME,
  ALL_MEMORY_TOOL_ID as MEMORY_TOOL_NAME
} from '@offgrid/models'

const project = { projectActive: true, allMemory: false }
const all = { projectActive: false, allMemory: true }
const none = { projectActive: false, allMemory: false }

describe('isMemoryToolAllowed — memory scope drives memory tools', () => {
  it('project scope offers the knowledge base, NOT all-memory search', () => {
    expect(isMemoryToolAllowed(KB_TOOL_NAME, project)).toBe(true)
    expect(isMemoryToolAllowed(MEMORY_TOOL_NAME, project)).toBe(false)
  })

  it('all-memory scope offers search_memory, NOT the (project-less) knowledge base', () => {
    expect(isMemoryToolAllowed(MEMORY_TOOL_NAME, all)).toBe(true)
    expect(isMemoryToolAllowed(KB_TOOL_NAME, all)).toBe(false)
  })

  it('no-memory scope offers neither memory tool', () => {
    expect(isMemoryToolAllowed(KB_TOOL_NAME, none)).toBe(false)
    expect(isMemoryToolAllowed(MEMORY_TOOL_NAME, none)).toBe(false)
  })

  it('non-memory tools are never gated by scope', () => {
    for (const scope of [project, all, none]) {
      expect(isMemoryToolAllowed('web_search', scope)).toBe(true)
      expect(isMemoryToolAllowed('read_url', scope)).toBe(true)
      expect(isMemoryToolAllowed('calculator', scope)).toBe(true)
    }
  })
})
