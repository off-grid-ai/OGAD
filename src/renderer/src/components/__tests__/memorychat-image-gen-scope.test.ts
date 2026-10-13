// D9 — image-generation UI state must be per-conversation. It used to be a global
// `generatingImage` bool + global `imgProgress`, so an image forming in one
// conversation showed its spinner (and a Stop that cancels it) in whatever tab you
// switched to. The fix tracks WHICH conversation owns the in-flight gen
// (imageGenConv) and derives the display from the active conversation.
//
// The full "start gen in A, switch to B, B shows no spinner" flow needs a
// two-conversation render harness (keeping a gen in-flight across a tab switch) —
// see DEVICE_TEST_LOG D9 for the on-device check. The state-shape guards below
// check the component; the stop test exercises the extracted stop function.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { stopChatRun, type StopDependencies } from '../../lib/chat-stop'

const src = readFileSync(join(__dirname, '..', 'MemoryChat/index.tsx'), 'utf8')

describe('MemoryChat image-gen state is per-conversation (D9)', () => {
  it('no longer stores generatingImage as a global bool', () => {
    expect(src).not.toMatch(/useState<?[^>]*>?\(false\)[^\n]*\/\/\s*.*generat/i)
    expect(src).not.toMatch(/\[generatingImage,\s*setGeneratingImage\]/)
  })

  it('tracks the owning conversation (imageGenConv) and derives generatingImage from the active one', () => {
    expect(src).toMatch(/\[imageGenConv,\s*setImageGenConv\]/)
    expect(src).toMatch(/const generatingImage = imageGenConv[\s\S]*?=== activeConversationId/)
  })

  it.each(['owner', 'other'])(
    'stopGeneration cancels the image job only when THIS conversation owns it (stopping %s)',
    async (conversationId) => {
      const dependencies: StopDependencies = {
        activeConversationId: conversationId,
        cancelledRef: { current: new Set() },
        streamConvRef: { current: new Map() },
        messagesByConvRef: { current: {} },
        answerByStream: { current: {} },
        reasoningByStream: { current: {} },
        timelineByStream: { current: {} },
        toolCallsByStream: { current: {} },
        queuedRef: { current: {} },
        setQueuedByConv: vi.fn(),
        stopLiveTask: vi.fn().mockResolvedValue(true),
        setAttachWarn: vi.fn(),
        dispatch: vi.fn(),
        cancelRag: vi.fn(),
        finalizeStoppedTurn: vi.fn(),
        markGenerating: vi.fn(),
        drainQueue: vi.fn(),
        imageGenConv: 'owner',
        cancelImageGen: vi.fn(),
        setImageGenConv: vi.fn(),
        setImgProgress: vi.fn(),
        setLoading: vi.fn()
      }

      await stopChatRun(dependencies, conversationId, null)

      if (conversationId === 'owner') {
        expect(dependencies.cancelImageGen).toHaveBeenCalledTimes(1)
        expect(dependencies.setImageGenConv).toHaveBeenCalledExactlyOnceWith(null)
        expect(dependencies.setImgProgress).toHaveBeenCalledExactlyOnceWith(null)
      } else {
        expect(dependencies.cancelImageGen).not.toHaveBeenCalled()
        expect(dependencies.setImageGenConv).not.toHaveBeenCalled()
        expect(dependencies.setImgProgress).not.toHaveBeenCalled()
      }
    }
  )
})
