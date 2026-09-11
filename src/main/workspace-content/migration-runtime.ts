import {
  desktopWorkspaceContentPersistence,
  type DesktopWorkspaceContentPersistence
} from '../composition/workspace-content'
import type {
  LegacyWorkspaceContentCopyResult,
  WorkspaceContentTargetJournalStatus
} from './legacy-migration'
import type {
  WorkspaceContentMigrationPreflight,
  WorkspaceContentMigrationReason,
  WorkspaceContentMigrationStatus,
  WorkspaceContentTable
} from './migration-preflight'

export interface DesktopWorkspaceContentMigrationPreflightSnapshot {
  readonly status: WorkspaceContentMigrationStatus
  readonly counts: Readonly<Record<WorkspaceContentTable, number>>
  readonly reasons: readonly Readonly<WorkspaceContentMigrationReason>[]
}

type BaseSnapshot = {
  readonly preflight: DesktopWorkspaceContentMigrationPreflightSnapshot
}

export type DesktopWorkspaceContentMigrationSnapshot =
  | (BaseSnapshot & { readonly phase: 'ready' })
  | (BaseSnapshot & { readonly phase: 'not_needed' })
  | (BaseSnapshot & { readonly phase: 'running' })
  | (BaseSnapshot & {
      readonly phase: 'completed'
      readonly result?: LegacyWorkspaceContentCopyResult
    })
  | (BaseSnapshot & {
      readonly phase: 'failed'
      readonly message: string
      readonly retryable: boolean
    })

export type DesktopWorkspaceContentMigrationListener = (
  snapshot: DesktopWorkspaceContentMigrationSnapshot
) => void

/** Process-local reactive owner for the Desktop workspace-content migration command. */
export class DesktopWorkspaceContentMigrationRuntime {
  private readonly listeners = new Set<DesktopWorkspaceContentMigrationListener>()
  private readonly persistence: DesktopWorkspaceContentPersistence
  private readonly preflight: DesktopWorkspaceContentMigrationPreflightSnapshot
  private snapshot: DesktopWorkspaceContentMigrationSnapshot
  private active: Promise<DesktopWorkspaceContentMigrationSnapshot> | null = null
  private requiredCompletion: Promise<DesktopWorkspaceContentMigrationSnapshot> | null = null

  constructor(persistence: DesktopWorkspaceContentPersistence) {
    this.persistence = persistence
    this.preflight = readonlyPreflight(persistence.preflight)
    this.snapshot = Object.freeze(
      initialSnapshot(this.preflight, persistence.readTargetJournalStatus())
    )
  }

  getSnapshot(): DesktopWorkspaceContentMigrationSnapshot {
    return this.snapshot
  }

  subscribe(listener: DesktopWorkspaceContentMigrationListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): Promise<DesktopWorkspaceContentMigrationSnapshot> {
    if (this.active) return this.active
    if (this.snapshot.phase === 'completed' || this.snapshot.phase === 'not_needed') {
      try {
        this.persistence.retireLegacyProjectOwner()
        return Promise.resolve(this.snapshot)
      } catch (cause) {
        return Promise.resolve(
          this.setSnapshot({
            phase: 'failed',
            preflight: this.preflight,
            message: failureMessage(cause),
            retryable: true
          })
        )
      }
    }
    if (this.snapshot.phase === 'failed' && !this.snapshot.retryable) {
      return Promise.resolve(this.snapshot)
    }

    const execution = Promise.resolve()
      .then(() => this.persistence.copyLegacyWorkspaceContent())
      .then((result) => {
        this.persistence.retireLegacyProjectOwner()
        return result
      })
      .then(
        (result): DesktopWorkspaceContentMigrationSnapshot => ({
          phase: 'completed',
          preflight: this.preflight,
          result: Object.freeze({ ...result })
        }),
        (cause): DesktopWorkspaceContentMigrationSnapshot => ({
          phase: 'failed',
          preflight: this.preflight,
          message: failureMessage(cause),
          retryable: true
        })
      )
      .then((snapshot) => {
        return this.setSnapshot(snapshot)
      })
    this.active = execution
    this.setSnapshot({ phase: 'running', preflight: this.preflight })
    void execution.finally(() => {
      if (this.active === execution) this.active = null
    })
    return execution
  }

  /**
   * The startup barrier. A failed attempt stays visible and waits for the same runtime's retry;
   * startup cannot convert a failed migration into partial readiness or create another coordinator.
   */
  awaitRequiredCompletion(): Promise<DesktopWorkspaceContentMigrationSnapshot> {
    if (this.snapshot.phase === 'completed' || this.snapshot.phase === 'not_needed') {
      try {
        this.persistence.retireLegacyProjectOwner()
        return Promise.resolve(this.snapshot)
      } catch (cause) {
        this.setSnapshot({
          phase: 'failed',
          preflight: this.preflight,
          message: failureMessage(cause),
          retryable: true
        })
      }
    }
    if (this.requiredCompletion) return this.requiredCompletion
    this.requiredCompletion = new Promise((resolve) => {
      let release = (): void => undefined
      const accept = (snapshot: DesktopWorkspaceContentMigrationSnapshot): void => {
        if (snapshot.phase !== 'completed' && snapshot.phase !== 'not_needed') return
        release()
        this.requiredCompletion = null
        resolve(snapshot)
      }
      release = this.subscribe(accept)
      void this.start().then(accept)
    })
    return this.requiredCompletion
  }

  private setSnapshot(
    snapshot: DesktopWorkspaceContentMigrationSnapshot
  ): DesktopWorkspaceContentMigrationSnapshot {
    this.snapshot = Object.freeze(snapshot)
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot)
      } catch {
        // A renderer or transport observer cannot interrupt a data migration.
      }
    }
    return this.snapshot
  }
}

function initialSnapshot(
  preflight: DesktopWorkspaceContentMigrationPreflightSnapshot,
  journalStatus: WorkspaceContentTargetJournalStatus
): DesktopWorkspaceContentMigrationSnapshot {
  if (journalStatus === 'completed') return { phase: 'completed', preflight }
  if (preflight.status === 'malformed') {
    return {
      phase: 'failed',
      preflight,
      message: preflight.reasons.map(({ detail }) => detail).join('; '),
      retryable: false
    }
  }
  const sourceRows = Object.values(preflight.counts).reduce((total, count) => total + count, 0)
  return sourceRows === 0 ? { phase: 'not_needed', preflight } : { phase: 'ready', preflight }
}

function readonlyPreflight(
  preflight: WorkspaceContentMigrationPreflight
): DesktopWorkspaceContentMigrationPreflightSnapshot {
  const counts = Object.freeze({ ...preflight.counts })
  const reasons = Object.freeze(preflight.reasons.map((reason) => Object.freeze({ ...reason })))
  return Object.freeze({ status: preflight.status, counts, reasons })
}

function failureMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.trim() || 'Workspace content migration failed.'
}

/** One migration runtime for the Desktop main process. */
export const desktopWorkspaceContentMigrationRuntime = new DesktopWorkspaceContentMigrationRuntime(
  desktopWorkspaceContentPersistence()
)
