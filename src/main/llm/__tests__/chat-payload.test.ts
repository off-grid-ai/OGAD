/**
 * Tests for the request-payload / message assembly - the single source of truth
 * used by both chat() and chatStream(). Covers: multimodal content parts with/without
 * images, mime detection, the system-message prepend rule, and the thinking-control
 * fragment on/off. Real inputs, no mocks.
 */

import { describe, it, expect } from 'vitest'
import {
  applyThinkingPayload,
  buildContentParts,
  buildMessages,
  imageMime,
  thinkingPayload,
  type DecodedImage
} from '../chat-payload'

const PNG: DecodedImage = { base64: 'AAAA', mime: 'image/png' }
const JPG: DecodedImage = { base64: 'BBBB', mime: 'image/jpeg' }

describe('imageMime', () => {
  it('maps .png (any case) to image/png', () => {
    expect(imageMime('/a/b.png')).toBe('image/png')
    expect(imageMime('/a/B.PNG')).toBe('image/png')
  })
  it('resolves each image type to its REAL MIME (not the old png-or-jpeg guess)', () => {
    expect(imageMime('/a/b.jpg')).toBe('image/jpeg')
    expect(imageMime('/a/b.jpeg')).toBe('image/jpeg')
    // Regression: webp/gif were mislabelled image/jpeg by the old rule, which the
    // vision model may reject. Now routed through the shared ext->MIME map.
    expect(imageMime('/a/b.webp')).toBe('image/webp')
    expect(imageMime('/a/b.gif')).toBe('image/gif')
  })
  it('falls back to image/png for an unknown/extensionless path', () => {
    expect(imageMime('/a/noext')).toBe('image/png')
  })
})

describe('buildContentParts', () => {
  it('text-only: a single text part', () => {
    expect(buildContentParts('hi', [])).toEqual([{ type: 'text', text: 'hi' }])
  })

  it('one image: text part then an image_url data URI', () => {
    expect(buildContentParts('look', [PNG])).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ])
  })

  it('preserves image order and uses each image mime', () => {
    const parts = buildContentParts('two', [PNG, JPG])
    expect(parts).toEqual([
      { type: 'text', text: 'two' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }
    ])
  })
})

describe('buildMessages', () => {
  it('no system prompt: just the user turn', () => {
    const msgs = buildMessages('hi', [], '')
    expect(msgs).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  it('blank/whitespace system prompt is NOT prepended (trim rule)', () => {
    const msgs = buildMessages('hi', [], '   \n  ')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]!.role).toBe('user')
  })

  it('non-blank system prompt is unshifted in front of the user turn', () => {
    const msgs = buildMessages('hi', [], 'be terse')
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toEqual({ role: 'system', content: 'be terse' })
    expect(msgs[1]!.role).toBe('user')
  })

  it('user content carries the images', () => {
    const msgs = buildMessages('look', [JPG], '')
    expect(msgs[0]!.content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }
    ])
  })
})

describe('thinkingPayload', () => {
  it('thinking ON: enable_thinking true + deepseek reasoning_format', () => {
    expect(thinkingPayload(true)).toEqual({
      chat_template_kwargs: { enable_thinking: true },
      reasoning_format: 'deepseek'
    })
  })

  it('thinking OFF: enable_thinking false, no reasoning_format', () => {
    expect(thinkingPayload(false)).toEqual({ chat_template_kwargs: { enable_thinking: false } })
  })
})

describe('applyThinkingPayload - the gateway speaks the loaded model\'s dialect', () => {
  it('keeps the enable_thinking form by default', () => {
    const body: Record<string, unknown> = { chat_template_kwargs: { enable_thinking: false } }
    expect(applyThinkingPayload(body)).toBe(true)
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
  })

  it('turns a client\'s "thinking off" into reasoning_strength for a model that reads that', () => {
    // Before, every request got enable_thinking, which this template ignores: "off" did nothing.
    const body: Record<string, unknown> = { chat_template_kwargs: { enable_thinking: false } }
    applyThinkingPayload(body, 'reasoning-strength')
    expect(body.chat_template_kwargs).toEqual({ reasoning_strength: 'none' })
    expect(body).not.toHaveProperty('reasoning_format')
  })

  it('sends no switch a template cannot read', () => {
    const body: Record<string, unknown> = { chat_template_kwargs: { enable_thinking: true } }
    applyThinkingPayload(body, 'none')
    expect(body.chat_template_kwargs).toBeUndefined()
  })

  it('leaves a request that says nothing about thinking alone', () => {
    const body: Record<string, unknown> = { messages: [] }
    expect(applyThinkingPayload(body, 'reasoning-strength')).toBe(false)
    expect(body).toEqual({ messages: [] })
  })
})
