import {
  CORE_SYNC_ENTITIES,
  createOffGridApplication,
  type ModelsPlatformPorts,
  type OffGridApplication,
  type RagDocument,
  type RagPlatformPorts,
  type SyncMutation,
  type WorkflowEvent
} from '@offgrid/application'
import type { RemoteServerConfiguration } from '@offgrid/models'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const DOCUMENT = {
  syncId: '11111111-1111-4111-8111-111111111111',
  projectId: 'project-alpha',
  name: 'Contract.txt',
  path: '/restored/Contract.txt',
  size: 42,
  createdAt: '2026-01-01T09:00:00.000Z'
} as const

function modelBoundary(): ModelsPlatformPorts {
  const selections = new Map<string, string | null>()
  let remoteConfiguration: RemoteServerConfiguration = {
    version: 1,
    activeServerId: null,
    servers: []
  }
  return {
    selection: {
      read: (modality) => selections.get(modality) ?? null,
      write: (modality, routeId) => {
        selections.set(modality, routeId)
      }
    },
    memory: {
      current: () => ({ totalMB: 16_000, availableMB: 8_000, platform: 'desktop' })
    },
    remote: {
      configuration: {
        read: () => remoteConfiguration,
        write: (value) => {
          remoteConfiguration = value
        }
      },
      credentials: {
        read: async () => null,
        write: async () => undefined,
        remove: async () => undefined
      },
      providers: {
        register: async () => undefined,
        unregister: async () => undefined
      },
      activateManaged: async () => ({})
    }
  }
}

/** In-memory substitutes for the database and file reader, which are external RAG boundaries. */
function ragBoundary(): RagPlatformPorts {
  const documents = new Map<number, RagDocument>()
  let nextId = 1
  return {
    embeddings: { dimension: 1, embed: async () => [1] },
    extraction: { readText: async () => 'Contract terms contain enough text to index.' },
    store: {
      addDocument: async (input) => {
        const id = nextId++
        documents.set(id, {
          id,
          syncId: input.syncId ?? `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
          projectId: input.projectId,
          name: input.name,
          path: input.path,
          size: input.size,
          kind: input.kind,
          enabled: input.enabled ?? true,
          createdAt: input.createdAt ?? '2026-01-01T09:00:00.000Z'
        })
        return id
      },
      addChunks: async () => undefined,
      getChunkCandidates: async () => [],
      listDocuments: async (projectId) =>
        [...documents.values()].filter((document) => document.projectId === projectId),
      listDocumentPage: async (afterId, limit) => {
        const page = [...documents.values()]
          .filter(({ id }) => id > (afterId ?? 0))
          .sort((left, right) => left.id - right.id)
          .slice(0, limit)
        return { documents: page, nextAfterId: null }
      },
      getDocument: async (docId) => documents.get(docId),
      getDocumentBySyncId: async (syncId) =>
        [...documents.values()].find((document) => document.syncId === syncId),
      setDocumentEnabled: async (docId, enabled) => {
        const document = documents.get(docId)
        if (document) documents.set(docId, { ...document, enabled })
      },
      deleteDocument: async (docId) => {
        documents.delete(docId)
      }
    }
  }
}

function createApplication(
  record?: (mutation: SyncMutation) => void | Promise<void>
): OffGridApplication {
  return createOffGridApplication({
    models: modelBoundary(),
    rag: ragBoundary(),
    ...(record
      ? {
          pro: {
            sync: {
              state: {
                record,
                sendKnowledgeDocument: async () => undefined
              }
            }
          }
        }
      : {})
  })
}

function addDocument(
  application: OffGridApplication
): ReturnType<OffGridApplication['rag']['addDocument']> {
  return application.rag.addDocument({
    projectId: DOCUMENT.projectId,
    path: DOCUMENT.path,
    fileName: DOCUMENT.name,
    size: DOCUMENT.size,
    syncId: DOCUMENT.syncId,
    createdAt: DOCUMENT.createdAt
  })
}

let application: OffGridApplication

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(async () => {
  await application?.stop()
})

describe('knowledge-document replication through the application facade', () => {
  it('records canonical knowledge-document state after a local index succeeds', async () => {
    const recorded: SyncMutation[] = []
    application = createApplication((mutation) => {
      recorded.push(mutation)
    })

    await expect(addDocument(application)).resolves.toMatchObject({ ok: true })

    expect(recorded).toEqual([
      {
        entity: CORE_SYNC_ENTITIES.knowledgeDocument,
        entityId: DOCUMENT.syncId,
        kind: 'put',
        fields: {
          project_id: DOCUMENT.projectId,
          name: DOCUMENT.name,
          created_at: DOCUMENT.createdAt,
          enabled: 1
        }
      }
    ])
  })

  it('records distinct index, enabled, and delete changes', async () => {
    const recorded: SyncMutation[] = []
    application = createApplication((mutation) => {
      recorded.push(mutation)
    })
    const indexed = await addDocument(application)
    expect(indexed.ok).toBe(true)
    if (!indexed.ok) return

    await application.rag.setDocumentEnabled(indexed.value.docId, false)
    await application.rag.removeDocument(indexed.value.docId)

    expect(recorded.map(({ kind }) => kind)).toEqual(['put', 'put', 'delete'])
    expect(recorded[1]).toMatchObject({ entityId: DOCUMENT.syncId, fields: { enabled: 0 } })
    expect(recorded[2]).toEqual({
      entity: CORE_SYNC_ENTITIES.knowledgeDocument,
      entityId: DOCUMENT.syncId,
      kind: 'delete'
    })
  })

  it('keeps the local index when no Pro sync state owner is present', async () => {
    application = createApplication()

    const indexed = await addDocument(application)
    expect(indexed.ok).toBe(true)
    if (!indexed.ok) return

    await expect(application.rag.document(indexed.value.docId)).resolves.toMatchObject({
      ok: true,
      value: { syncId: DOCUMENT.syncId }
    })
  })

  it('keeps the local index and reports a bridge failure when sync persistence fails', async () => {
    const events: WorkflowEvent[] = []
    application = createApplication(() => {
      throw new Error('peer handshake in progress')
    })
    application.workflows.events((event) => events.push(event))

    const indexed = await addDocument(application)
    expect(indexed.ok).toBe(true)
    if (!indexed.ok) return
    await vi.waitFor(() => {
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'bridge_failed',
          bridge: 'knowledge_document_replication'
        })
      )
    })
    await expect(application.rag.document(indexed.value.docId)).resolves.toMatchObject({
      ok: true,
      value: { syncId: DOCUMENT.syncId }
    })
  })

  it('records later changes after one sync persistence failure', async () => {
    const recorded: SyncMutation[] = []
    let failNext = true
    application = createApplication((mutation) => {
      if (failNext) {
        failNext = false
        throw new Error('transient')
      }
      recorded.push(mutation)
    })

    const indexed = await addDocument(application)
    expect(indexed.ok).toBe(true)
    if (!indexed.ok) return
    await application.rag.removeDocument(indexed.value.docId)

    expect(recorded).toEqual([
      {
        entity: CORE_SYNC_ENTITIES.knowledgeDocument,
        entityId: DOCUMENT.syncId,
        kind: 'delete'
      }
    ])
  })
})
