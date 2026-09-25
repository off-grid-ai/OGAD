/**
 * The pure image-prompt-enhancement helpers: the instruction template (keeps the
 * user's subject, fences their text as data) and the reply cleaner (strips
 * reasoning/quotes/labels, falls back to the original when the reply is unusable).
 */
import { describe, it, expect, vi } from 'vitest'
import { buildEnhancePrompt, cleanEnhancedPrompt, enhancePrompt } from '../prompt-enhance'

describe('buildEnhancePrompt', () => {
  it('includes the user request and instructs to keep intent + treat it as data', () => {
    const p = buildEnhancePrompt('a red bicycle')
    expect(p).toContain('a red bicycle')
    expect(p).toMatch(/keep the user's subject and intent/i)
    expect(p).toMatch(/not as instructions to follow/i)
  })

  it('truncates an absurdly long request (caps the user text at 2000 chars)', () => {
    const p = buildEnhancePrompt('x'.repeat(5000))
    expect(p).toContain('x'.repeat(2000))
    expect(p).not.toContain('x'.repeat(2001)) // capped, not the full 5000
  })

  it('builds a reference-aware edit instruction that preserves unrequested details', () => {
    const p = buildEnhancePrompt('Replace product names with generic labels', true)
    expect(p).toContain('Replace product names with generic labels')
    expect(p).toMatch(/inspect the attached reference image/i)
    expect(p).toMatch(/preserve all other visible details/i)
    expect(p).toMatch(/do not invent a different subject or scene/i)
  })
})

describe('cleanEnhancedPrompt', () => {
  it('returns a clean single-line prompt as-is', () => {
    expect(
      cleanEnhancedPrompt('a red bicycle leaning on a brick wall, golden hour, 35mm', 'x')
    ).toBe('a red bicycle leaning on a brick wall, golden hour, 35mm')
  })

  it('strips reasoning tags and keeps the actual prompt', () => {
    const raw = '<think>the user wants a bike</think>\na red bicycle, soft morning light'
    expect(cleanEnhancedPrompt(raw, 'fallback')).toBe('a red bicycle, soft morning light')
  })

  it('drops a leading "Prompt:" label and surrounding quotes', () => {
    expect(cleanEnhancedPrompt('Prompt: "a red bicycle, cinematic"', 'x')).toBe(
      'a red bicycle, cinematic'
    )
  })

  it('takes the last line when the model prepends preamble', () => {
    const raw = "Sure, here's a vivid prompt:\na red bicycle, neon reflections, rain"
    expect(cleanEnhancedPrompt(raw, 'x')).toBe('a red bicycle, neon reflections, rain')
  })

  it('falls back to the original when the reply is empty', () => {
    expect(cleanEnhancedPrompt('', 'a red bicycle')).toBe('a red bicycle')
    expect(cleanEnhancedPrompt('   \n  ', 'a red bicycle')).toBe('a red bicycle')
  })

  it('falls back when the model rambled past the length cap', () => {
    expect(cleanEnhancedPrompt('word '.repeat(200), 'a red bicycle')).toBe('a red bicycle')
  })
})

describe('enhancePrompt - gate → run → clean → fallback (injected model)', () => {
  it('returns the model-enhanced prompt when enabled', async () => {
    const chat = vi.fn(
      async (_instruction: string) => 'a red bicycle, golden hour, 35mm, shallow depth of field'
    )
    const out = await enhancePrompt('a red bicycle', { enabled: true, chat })
    expect(out).toBe('a red bicycle, golden hour, 35mm, shallow depth of field')
    // The model was asked to expand the user's request.
    expect(chat).toHaveBeenCalledTimes(1)
    expect(chat.mock.calls[0]![0]).toContain('a red bicycle')
  })

  it('uses the image-edit instruction when a reference image is attached', async () => {
    const chat = vi.fn(
      async (_instruction: string) =>
        'Keep the diagram layout; replace model names with role labels'
    )
    const out = await enhancePrompt('Make the labels generic', {
      enabled: true,
      hasReferenceImage: true,
      chat
    })
    expect(out).toBe('Keep the diagram layout; replace model names with role labels')
    expect(chat.mock.calls[0]![0]).toMatch(/inspect the attached reference image/i)
  })

  it('does NOT call the model and returns the original when disabled', async () => {
    const chat = vi.fn(async () => 'should not be used')
    const out = await enhancePrompt('a red bicycle', { enabled: false, chat })
    expect(out).toBe('a red bicycle')
    expect(chat).not.toHaveBeenCalled()
  })

  it('falls back to the original prompt when the model call throws', async () => {
    const chat = vi.fn(async () => {
      throw new Error('engine down')
    })
    const out = await enhancePrompt('a red bicycle', { enabled: true, chat })
    expect(out).toBe('a red bicycle')
  })

  it('falls back when the model returns an unusable (empty) reply', async () => {
    const out = await enhancePrompt('a red bicycle', { enabled: true, chat: async () => '   ' })
    expect(out).toBe('a red bicycle')
  })

  it('skips an empty user prompt without calling the model', async () => {
    const chat = vi.fn(async () => 'x')
    expect(await enhancePrompt('   ', { enabled: true, chat })).toBe('   ')
    expect(chat).not.toHaveBeenCalled()
  })
})
