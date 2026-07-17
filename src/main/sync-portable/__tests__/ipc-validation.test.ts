import { describe, expect, it } from 'vitest'
import { boundedId, collisionPolicy } from '../ipc-validation'

describe('portable workspace IPC validation', () => {
  it('accepts only bounded identifiers', () => {
    expect(boundedId('project-1', 'Project ID')).toBe('project-1')
    expect(() => boundedId('', 'Project ID')).toThrow('non-empty identifier')
    expect(() => boundedId('x'.repeat(513), 'Project ID')).toThrow('at most 512')
    expect(() => boundedId({ id: 'project-1' }, 'Project ID')).toThrow('non-empty identifier')
  })

  it('accepts only canonical collision policies', () => {
    expect(collisionPolicy(undefined)).toBeUndefined()
    expect(collisionPolicy('replace-existing')).toBe('replace-existing')
    expect(() => collisionPolicy('overwrite')).toThrow('Unsupported')
  })
})
