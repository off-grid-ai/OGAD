import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerHook, HOOKS } from '../bootstrap/hookRegistry'
import {
  emitKnowledgeDocumentMutation,
  type KnowledgeDocumentMutation
} from '../sync-knowledge-document'

/**
 * How core tells Pro that a knowledge document changed - and why core does not care whether Pro is there.
 *
 * This is the open-core seam. The free build has no sync coordinator, so the hook is simply unregistered,
 * and indexing a document must work exactly the same. In a paid build the coordinator is on the other end,
 * and if IT throws - a peer mid-handshake, a disk error while queueing - the user's document is already
 * indexed locally and must stay that way. So the one behaviour worth protecting is that nothing this hook
 * does can fail the RAG write that preceded it.
 */

const snapshot = {
  syncId: 'doc-sync-1',
  projectId: 'project-alpha',
  name: 'Contract.pdf',
  filePath: '/restored/Contract.pdf',
  fileSize: 42,
  createdAt: '2026-01-01T09:00:00.000Z',
  enabled: true
}

describe('announcing a knowledge document change to the optional sync coordinator', () => {
  beforeEach(() => {
    // Back to the free-build shape between tests: no coordinator listening.
    registerHook(HOOKS.syncKnowledgeDocumentMutation, undefined as never)
    vi.restoreAllMocks()
  })

  it('hands the coordinator exactly what it was given', () => {
    const seen: KnowledgeDocumentMutation[] = []
    registerHook(HOOKS.syncKnowledgeDocumentMutation, (mutation) => {
      seen.push(mutation as KnowledgeDocumentMutation)
    })

    emitKnowledgeDocumentMutation({ kind: 'indexed', document: snapshot })

    // Passed through unchanged: the coordinator needs the file path and size to offer the document to a
    // peer, and the syncId to recognise it later. Anything summarised away here cannot be recovered.
    expect(seen).toEqual([{ kind: 'indexed', document: snapshot }])
  })

  it('carries each kind of change the coordinator has to distinguish', () => {
    const seen: KnowledgeDocumentMutation[] = []
    registerHook(HOOKS.syncKnowledgeDocumentMutation, (mutation) => {
      seen.push(mutation as KnowledgeDocumentMutation)
    })

    emitKnowledgeDocumentMutation({ kind: 'indexed', document: snapshot })
    emitKnowledgeDocumentMutation({ kind: 'enabled', syncId: 'doc-sync-1', enabled: false })
    emitKnowledgeDocumentMutation({ kind: 'deleted', syncId: 'doc-sync-1' })

    // Three different things happen to a document, and they mean three different things to a peer: send
    // it, stop using it, forget it. A single "changed" event would force the far side to guess.
    expect(seen.map((mutation) => mutation.kind)).toEqual(['indexed', 'enabled', 'deleted'])
    expect(seen[1]).toEqual({ kind: 'enabled', syncId: 'doc-sync-1', enabled: false })
    expect(seen[2]).toEqual({ kind: 'deleted', syncId: 'doc-sync-1' })
  })

  it('does nothing at all in a build with no coordinator', () => {
    // An unlicensed install. Not an error and not a warning: there is nobody to tell, and indexing a document is a
    // core feature that must not notice pro's absence.
    expect(() =>
      emitKnowledgeDocumentMutation({ kind: 'indexed', document: snapshot })
    ).not.toThrow()
  })

  it('swallows a coordinator failure so the local index is not undone by it', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerHook(HOOKS.syncKnowledgeDocumentMutation, () => {
      throw new Error('peer handshake in progress')
    })

    // The document is already indexed by the time this runs. Letting the throw escape would fail the
    // caller's write path and lose a document the user successfully added, because a PEER was busy.
    expect(() =>
      emitKnowledgeDocumentMutation({ kind: 'indexed', document: snapshot })
    ).not.toThrow()

    // Swallowed, not hidden: the failure is logged with the mutation, so a document that never reached a
    // peer can be traced rather than silently missing.
    expect(logged).toHaveBeenCalledWith(
      '[sync] Failed to record knowledge document mutation',
      { kind: 'indexed', document: snapshot },
      expect.any(Error)
    )
  })

  it('keeps announcing later changes after one of them failed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: KnowledgeDocumentMutation[] = []
    let failNext = true
    registerHook(HOOKS.syncKnowledgeDocumentMutation, (mutation) => {
      if (failNext) {
        failNext = false
        throw new Error('transient')
      }
      seen.push(mutation as KnowledgeDocumentMutation)
    })

    emitKnowledgeDocumentMutation({ kind: 'indexed', document: snapshot })
    emitKnowledgeDocumentMutation({ kind: 'deleted', syncId: 'doc-sync-1' })

    // One bad announcement must not latch the seam off - the next change still goes out, so a transient
    // failure costs one event rather than every event after it.
    expect(seen).toEqual([{ kind: 'deleted', syncId: 'doc-sync-1' }])
  })
})
