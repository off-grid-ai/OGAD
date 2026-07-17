import type {
  ImportCollisionPolicy,
  PortableWorkspaceSummary,
  PortableWorkspaceUiPort,
  WorkspaceTransferCounts,
  WorkspaceTransferResult
} from '@offgrid/sync-desktop'
import type {
  SyncPortableImportSummary,
  SyncPortableSummary
} from '../../../../shared/sync-portable-contract'

const KEEP_EXISTING = 'keep-existing' as const

function ensureActive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The workspace transfer was cancelled.', 'AbortError')
}

function toSummary(summary: SyncPortableSummary): PortableWorkspaceSummary {
  return {
    projects: summary.projects,
    conversations: summary.conversations,
    documents: summary.documents,
    attachments: summary.attachments
  }
}

function toExportCounts(summary: SyncPortableSummary): WorkspaceTransferCounts {
  return { ...toSummary(summary), messages: summary.messages }
}

function toImportCounts(summary: SyncPortableImportSummary): WorkspaceTransferCounts {
  return {
    projects: summary.projectsAdded + summary.projectsUpdated,
    conversations: summary.conversationsAdded + summary.conversationsUpdated,
    messages: summary.messagesAdded + summary.messagesUpdated,
    documents: summary.documentsAdded + summary.documentsUpdated,
    attachments: summary.attachmentsImported
  }
}

async function readSummary(signal: AbortSignal): Promise<SyncPortableSummary> {
  ensureActive(signal)
  const summary = await window.api.sync.summary()
  ensureActive(signal)
  return summary
}

export const portableWorkspaceHost: PortableWorkspaceUiPort = Object.freeze({
  supportedCollisionPolicies: Object.freeze([KEEP_EXISTING]),

  async readSummary(signal): Promise<PortableWorkspaceSummary> {
    return toSummary(await readSummary(signal))
  },

  async exportWorkspace(signal): Promise<WorkspaceTransferResult> {
    const counts = toExportCounts(await readSummary(signal))
    const result = await window.api.sync.exportAll()
    ensureActive(signal)
    return result === null || result.canceled
      ? { status: 'cancelled' }
      : { status: 'completed', counts }
  },

  async importWorkspace(
    collisionPolicy: ImportCollisionPolicy,
    signal: AbortSignal
  ): Promise<WorkspaceTransferResult> {
    ensureActive(signal)
    if (collisionPolicy !== KEEP_EXISTING) {
      throw new Error('Unsupported workspace collision policy.')
    }
    const result = await window.api.sync.importPicker()
    ensureActive(signal)
    return result === null
      ? { status: 'cancelled' }
      : { status: 'completed', counts: toImportCounts(result) }
  }
})
