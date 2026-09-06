import type { ApplicationStatus } from '@offgrid/application'

export interface BackupRecoveryLifecycle {
  snapshot(): { readonly status: ApplicationStatus }
  subscribe(listener: () => void): () => void
}

export class BackupRestoreAdmission {
  private open = true
  private suspensions = 0
  private reopenAfterSuspend = true
  private readonly active = new Set<Promise<unknown>>()
  private requestRecovery: (() => void) | null = null

  isOpen(): boolean {
    return this.open
  }

  setRecoveryRequest(request: () => void): () => void {
    this.requestRecovery = request
    return () => {
      if (this.requestRecovery === request) this.requestRecovery = null
    }
  }

  admit<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (!this.open) {
      return Promise.reject(new Error('Backup restore is paused for personal data deletion.'))
    }
    const running = operation()
    this.active.add(running)
    void running.finally(() => this.active.delete(running)).catch(() => {})
    return running
  }

  async suspend(): Promise<void> {
    if (this.suspensions === 0) {
      this.reopenAfterSuspend = this.open
      this.open = false
    }
    this.suspensions += 1
    await Promise.allSettled([...this.active])
  }

  resume(): void {
    if (this.suspensions === 0) return
    this.suspensions -= 1
    if (this.suspensions > 0 || !this.reopenAfterSuspend) return
    this.open = true
    this.requestRecovery?.()
  }
}

export function startBackupRestoreRecovery(
  admission: BackupRestoreAdmission,
  application: BackupRecoveryLifecycle,
  recover: () => Promise<void>
): () => void {
  let running = false
  const resume = (): void => {
    if (running || !admission.isOpen() || application.snapshot().status !== 'running') return
    running = true
    void admission
      .admit(recover)
      .catch((cause: unknown) => console.error('[backup] restore recovery failed', cause))
      .finally(() => {
        running = false
      })
  }
  const clearRecoveryRequest = admission.setRecoveryRequest(resume)
  const stop = application.subscribe(resume)
  resume()
  return () => {
    clearRecoveryRequest()
    stop()
  }
}
