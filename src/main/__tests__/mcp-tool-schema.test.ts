import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { jsonSchemaToZodShape } from '../mcp-tool-schema'

describe('jsonSchemaToZodShape', () => {
  it('maps types, marks non-required keys optional, and keeps descriptions', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        allDay: { type: 'boolean' },
        count: { type: 'integer' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['title']
    })
    const obj = z.object(shape)
    expect(obj.safeParse({ title: 'x' }).success).toBe(true) // only the required field
    expect(obj.safeParse({ title: 'x', allDay: true, count: 2, tags: ['a'] }).success).toBe(true)
    expect(obj.safeParse({}).success).toBe(false) // missing required title
    expect(obj.safeParse({ title: 'x', count: 'nope' }).success).toBe(false) // wrong type
    // The description carries through to the Zod schema (MCP surfaces it).
    expect((shape.title as z.ZodString).description).toBe('Event title')
  })

  it('handles an empty schema and enum properties', () => {
    expect(jsonSchemaToZodShape({ type: 'object', properties: {} })).toEqual({})
    const shape = jsonSchemaToZodShape({
      properties: { key: { type: 'string', enum: ['Enter', 'Tab'] } },
      required: ['key']
    })
    const obj = z.object(shape)
    expect(obj.safeParse({ key: 'Enter' }).success).toBe(true)
    expect(obj.safeParse({ key: 'Nope' }).success).toBe(false)
  })
})
