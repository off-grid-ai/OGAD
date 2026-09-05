import { describe, expect, it } from 'vitest'
import type { KnowledgeDocumentSnapshot, RagEvent, RagFailure } from '@offgrid/application'
import { replicatedRagDocuments, type RagReplicationSource } from '../rag-replication'

/**
 * A truncated replication read is REFUSED, not mistaken for the whole set.
 *
 * The Shared facade's `rag.sync.allDocuments()` never throws: a failure mid-stream ends the
 * iteration and is reported on `rag.events` as `sync_all_documents`. The product contract for a
 * peer backfill or a full-state push is that the consumer either receives the COMPLETE set or an
 * error carrying the failure's own message - never a partial list that looks whole.
 *
 * The source is the module's one parameter and is exactly the two facade members it reads (the
 * stream and the event feed), so it is stood up here as a real, scripted facade edge: documents are
 * yielded in order and an `operation_failed` event is published at a chosen point, exactly as the
 * facade does it. Nothing of ours is mocked.
 */

const snapshot = (n: number): KnowledgeDocumentSnapshot => ({
  syncId: `doc-${n}`,
  projectId: 'project-1',
  name: `Document ${n}.md`,
  filePath: `/Users/someone/Documents/Document ${n}.md`,
  fileSize: 100 * n,
  createdAt: '2026-09-01T10:00:00.000Z',
  enabled: true
})

const readFailure: RagFailure = {
  kind: 'runtime',
  operation: 'sync_all_documents',
  message: 'database is locked'
}

interface ScriptedSource extends RagReplicationSource {
  readonly listeners: () => number
  publish(event: RagEvent): void
}

/**
 * A facade edge that yields `documents` and, when `failAfter` is set, publishes the failure event
 * after that many documents and ends the stream - the facade's exact "ended, not thrown" shape.
 */
function scriptedSource(
  documents: KnowledgeDocumentSnapshot[],
  options: { failAfter?: number; failure?: RagFailure; events?: RagEvent[] } = {}
): ScriptedSource {
  const listeners = new Set<(event: RagEvent) => void>()
  const publish = (event: RagEvent): void => listeners.forEach((listener) => listener(event))
  return {
    listeners: () => listeners.size,
    publish,
    events(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    sync: {
      async *allDocuments() {
        for (const [index, document] of documents.entries()) {
          if (options.failAfter !== undefined && index === options.failAfter) {
            publish({
              type: 'operation_failed',
              operation: 'sync_all_documents',
              failure: options.failure ?? readFailure
            })
            return
          }
          yield document
        }
        for (const event of options.events ?? []) publish(event)
      }
    }
  }
}

const drain = async (
  source: RagReplicationSource
): Promise<{ received: KnowledgeDocumentSnapshot[]; error?: Error }> => {
  const received: KnowledgeDocumentSnapshot[] = []
  try {
    for await (const document of replicatedRagDocuments(source)) received.push(document)
    return { received }
  } catch (error) {
    return { received, error: error as Error }
  }
}

describe('replicatedRagDocuments', () => {
  it('passes a complete read through in order and releases the event subscription', async () => {
    const source = scriptedSource([snapshot(1), snapshot(2), snapshot(3)])
    const { received, error } = await drain(source)
    expect(error).toBeUndefined()
    expect(received.map((d) => d.syncId)).toEqual(['doc-1', 'doc-2', 'doc-3'])
    expect(source.listeners()).toBe(0)
  })

  it('completes an empty set as a complete set', async () => {
    const source = scriptedSource([])
    await expect(drain(source)).resolves.toEqual({ received: [] })
    expect(source.listeners()).toBe(0)
  })

  it('throws the failure message when the stream broke after some documents', async () => {
    const source = scriptedSource([snapshot(1), snapshot(2), snapshot(3)], { failAfter: 2 })
    const { received, error } = await drain(source)
    expect(received.map((d) => d.syncId)).toEqual(['doc-1', 'doc-2'])
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).toBe('database is locked')
    expect(source.listeners()).toBe(0)
  })

  it('throws when the stream broke before the first document', async () => {
    const source = scriptedSource([snapshot(1)], {
      failAfter: 0,
      failure: { kind: 'unavailable', message: 'RAG is not available on this device' }
    })
    const { received, error } = await drain(source)
    expect(received).toEqual([])
    expect(error?.message).toBe('RAG is not available on this device')
  })

  it('stops yielding once a failure has landed, even if the stream keeps producing', async () => {
    const source: ScriptedSource = {
      ...scriptedSource([]),
      sync: {
        async *allDocuments() {
          yield snapshot(1)
          source.publish({ type: 'operation_failed', operation: 'sync_all_documents', failure: readFailure })
          yield snapshot(2)
          yield snapshot(3)
        }
      }
    }
    const { received, error } = await drain(source)
    expect(received.map((d) => d.syncId)).toEqual(['doc-1'])
    expect(error?.message).toBe('database is locked')
  })

  it('reports the FIRST failure when more than one is published', async () => {
    const source: ScriptedSource = {
      ...scriptedSource([]),
      sync: {
        async *allDocuments() {
          yield snapshot(1)
          source.publish({ type: 'operation_failed', operation: 'sync_all_documents', failure: readFailure })
          source.publish({
            type: 'operation_failed',
            operation: 'sync_all_documents',
            failure: { kind: 'unavailable', message: 'later, less informative' }
          })
        }
      }
    }
    const { error } = await drain(source)
    expect(error?.message).toBe('database is locked')
  })

  it('ignores failures of other operations and non-failure events', async () => {
    const source = scriptedSource([snapshot(1), snapshot(2)], {
      events: [
        { type: 'operation_failed', operation: 'search', failure: { kind: 'runtime', operation: 'search', message: 'nope' } },
        { type: 'operation_failed', operation: 'sync_index', failure: { kind: 'unavailable', message: 'nope' } }
      ]
    })
    const { received, error } = await drain(source)
    expect(error).toBeUndefined()
    expect(received).toHaveLength(2)
  })

  it('gives a consumer that breaks out early its own control flow back, with no error', async () => {
    const source = scriptedSource([snapshot(1), snapshot(2), snapshot(3)], { failAfter: 2 })
    const received: string[] = []
    for await (const document of replicatedRagDocuments(source)) {
      received.push(document.syncId)
      break
    }
    expect(received).toEqual(['doc-1'])
    expect(source.listeners()).toBe(0)
  })

  it('releases the subscription when the source stream itself throws', async () => {
    const source: ScriptedSource = {
      ...scriptedSource([]),
      sync: {
        async *allDocuments() {
          yield snapshot(1)
          throw new Error('adapter exploded')
        }
      }
    }
    const { received, error } = await drain(source)
    expect(received).toHaveLength(1)
    expect(error?.message).toBe('adapter exploded')
    expect(source.listeners()).toBe(0)
  })
})
