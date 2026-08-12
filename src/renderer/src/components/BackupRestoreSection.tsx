import { useState } from 'react'
import { DownloadSimple, UploadSimple } from '@phosphor-icons/react'
import type {
  BackupDeliveryContract,
  BackupRestoreSummaryContract
} from '../../../shared/backup-contracts'
import { Button } from './ui/button'

type BackupAction = 'export' | 'restore'

function count(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? '' : 's'}`
}

function restoreMessage(summary: BackupRestoreSummaryContract): string {
  const added =
    summary.projectsAdded +
    summary.conversationsAdded +
    summary.messagesAdded +
    summary.documentsAdded
  if (added === 0) return 'Backup checked. This device already has everything in it.'
  return `Restored ${count(summary.projectsAdded, 'project')}, ${count(summary.conversationsAdded, 'chat')}, ${count(summary.messagesAdded, 'message')}, and ${count(summary.documentsAdded, 'document')}.`
}

export function BackupRestoreSection(): React.ReactElement {
  const [busy, setBusy] = useState<BackupAction | null>(null)
  const [status, setStatus] = useState('')
  const [failed, setFailed] = useState(false)

  const run = async <T,>(
    action: BackupAction,
    operation: () => Promise<T>,
    onSuccess: (result: T) => string
  ): Promise<void> => {
    setBusy(action)
    setStatus('')
    setFailed(false)
    try {
      setStatus(onSuccess(await operation()))
    } catch (cause) {
      setFailed(true)
      setStatus(cause instanceof Error ? cause.message : 'The backup operation failed.')
    } finally {
      setBusy(null)
    }
  }

  const exportBackup = (): Promise<void> =>
    run<BackupDeliveryContract | null>(
      'export',
      () => window.api.exportBackup(),
      (result) =>
        !result || result.canceled
          ? 'Backup canceled.'
          : `Backup saved${result.path ? ` to ${result.path}` : ''}.`
    )

  const importBackup = (): Promise<void> =>
    run<BackupRestoreSummaryContract | null>(
      'restore',
      () => window.api.importBackup(),
      (result) => (result ? restoreMessage(result) : 'Restore canceled.')
    )

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <section className="border border-neutral-800 bg-neutral-950/40 p-3">
        <div className="mb-3">
          <h4 className="text-sm text-neutral-200">Create a portable backup</h4>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            Save your chats, projects, project instructions, and knowledge files as one ZIP file.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={busy !== null}
          onClick={() => void exportBackup()}
          className="rounded-none bg-emerald-600 text-white active:scale-95"
        >
          <DownloadSimple />
          {busy === 'export' ? 'Creating backup...' : 'Create backup'}
        </Button>
      </section>

      <section className="border border-neutral-800 bg-neutral-950/40 p-3">
        <div className="mb-3">
          <h4 className="text-sm text-neutral-200">Restore from a backup</h4>
          <p className="mt-1 text-xs leading-relaxed text-neutral-500">
            Add missing chats, projects, and knowledge files. Existing data stays unchanged.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void importBackup()}
          className="rounded-none border-neutral-700 bg-transparent active:scale-95"
        >
          <UploadSimple />
          {busy === 'restore' ? 'Restoring...' : 'Choose backup'}
        </Button>
      </section>

      {status ? (
        <p
          role={failed ? 'alert' : 'status'}
          className={`lg:col-span-2 border px-3 py-2 text-xs ${
            failed
              ? 'border-red-500/40 bg-red-500/10 text-red-300'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          }`}
        >
          {status}
        </p>
      ) : null}
    </div>
  )
}
