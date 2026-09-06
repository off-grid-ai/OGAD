// D9 — image-generation UI state must be per-conversation. It used to be a global
// `generatingImage` bool + global `imgProgress`, so an image forming in one
// conversation showed its spinner (and a Stop that cancels it) in whatever tab you
// switched to. The fix tracks WHICH conversation owns the in-flight gen
// (imageGenConv) and derives the display from the active conversation.
//
// The full "start gen in A, switch to B, B shows no spinner" flow needs a
// two-conversation render harness (keeping a gen in-flight across a tab switch) —
// see DEVICE_TEST_LOG D9 for the on-device check. This is the source-contract guard
// that the global-bool bug can't come back: it was red on HEAD (which had the
// `useState(false)` global bool) and passes on the per-conversation shape.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

const src = readFileSync(join(__dirname, '..', 'MemoryChat.tsx'), 'utf8')

describe('MemoryChat image-gen state is per-conversation (D9)', () => {
  it('no longer stores generatingImage as a global bool', () => {
    expect(src).not.toMatch(/useState<?[^>]*>?\(false\)[^\n]*\/\/\s*.*generat/i)
    expect(src).not.toMatch(/\[generatingImage,\s*setGeneratingImage\]/)
  })

  it('tracks the owning conversation (imageGenConv) and derives generatingImage from the active one', () => {
    expect(src).toMatch(/\[imageGenConv,\s*setImageGenConv\]/)
    expect(src).toMatch(/const generatingImage = imageGenConv[\s\S]*?=== activeConversationId/)
  })

  it('delegates scoped cancellation to the one chat-session boundary', () => {
    expect(src).toMatch(/desktopChatSession\.stopConversation\(convId/)
    expect(src).not.toMatch(/window\.api\.cancelImageGen/)
    expect(src).not.toMatch(/window\.api\.cancelRag/)
  })
})
