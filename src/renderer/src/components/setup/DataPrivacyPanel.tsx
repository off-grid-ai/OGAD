import { useCallback, useEffect, useState } from 'react'
import { Archive, ArrowsClockwise, FolderOpen, Trash, Warning, X } from '@phosphor-icons/react'
import {
  ARCHIVABLE_CATEGORIES,
  AUTO_CLEANUP_SETTING_KEY,
  type AutoCleanupConfigContract,
  type AutoCleanupStatusContract,
  type DataCategoryId
} from '../../../../shared/backup-contracts'

const RETENTION_CHOICES = [
  { days: 0, label: 'Off' },
  { days: 30, label: '30 days' },
  { days: 60, label: '60 days' },
  { days: 90, label: '90 days' }
]

interface DataCategory {
  id: DataCategoryId
  label: string
  detail: string
  count?: number
  bytes?: number
}

function fmtBytes(b?: number): string | null {
  if (!b) return null
  if (b < 1e6) return `${(b / 1e3).toFixed(0)} KB`
  if (b < 1e9) return `${(b / 1e6).toFixed(0)} MB`
  return `${(b / 1e9).toFixed(1)} GB`
}

/** One place to delete on-device data: per-category clear + a full reset. Real,
 *  immediate deletion (this is local data on the user's machine). */
export function DataPrivacyPanel(): React.ReactElement {
  const api = window.api
  const [cats, setCats] = useState<DataCategory[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  // Per-category "Back up first": when on, the delete buttons archive to a
  // user-picked ZIP before clearing (fail closed - cancel deletes nothing).
  const [backupFirst, setBackupFirst] = useState<Set<DataCategoryId>>(new Set())
  // Automatic history cleanup (Phase 2): config + last run, owned by the main process.
  const [auto, setAuto] = useState<AutoCleanupStatusContract | null>(null)

  const toggleBackupFirst = (id: DataCategoryId): void => {
    setBackupFirst((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const refresh = useCallback(async () => {
    try {
      const c = await api.getDataSummary()
      if (Array.isArray(c)) setCats(c as DataCategory[])
    } catch {
      /* keep last */
    }
  }, [api])

  const refreshAuto = useCallback(async () => {
    try {
      setAuto(await api.getAutoCleanupStatus())
    } catch {
      /* keep last */
    }
  }, [api])

  useEffect(() => {
    refresh()
    refreshAuto()
  }, [refresh, refreshAuto])

  // Save, then re-read from main - it sanitizes the config, so main stays the SSOT.
  const saveAutoCleanup = async (config: AutoCleanupConfigContract): Promise<void> => {
    await api.saveSetting(AUTO_CLEANUP_SETTING_KEY, config)
    await refreshAuto()
  }

  const runCleanupNow = async (): Promise<void> => {
    setBusy('auto-cleanup')
    try {
      await api.runAutoCleanupNow()
      await refresh()
      await refreshAuto()
    } finally {
      setBusy(null)
    }
  }

  // Time-based retention is offered for captures + meetings (they accumulate).
  const RETENTION: Record<string, { label: string; days: number }[]> = {
    captures: [
      { label: '> 3 days', days: 3 },
      { label: '> 7 days', days: 7 },
      { label: '> 30 days', days: 30 }
    ],
    meetings: [
      { label: '> 7 days', days: 7 },
      { label: '> 30 days', days: 30 },
      { label: '> 90 days', days: 90 }
    ]
  }

  const clearOne = async (c: DataCategory, olderThanDays?: number): Promise<void> => {
    const what = olderThanDays
      ? `${c.label.toLowerCase()} older than ${olderThanDays} days`
      : `all ${c.label.toLowerCase()}`
    if (backupFirst.has(c.id)) {
      if (
        !window.confirm(
          `Back up ${what} to a ZIP, then delete? You'll pick where the backup is saved - canceling that deletes nothing.`
        )
      )
        return
      setBusy(c.id)
      try {
        const result = await api.archiveDataCategory(c.id, olderThanDays)
        if (result.status === 'failed')
          window.alert(`Backup failed - nothing was deleted. ${result.error}`)
        await refresh()
      } finally {
        setBusy(null)
      }
      return
    }
    if (
      !window.confirm(
        `Delete ${what}? This permanently removes it from this device and can't be undone.`
      )
    )
      return
    setBusy(c.id)
    try {
      await api.clearDataCategory(c.id, olderThanDays)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const deleteEverything = async (): Promise<void> => {
    if (
      !window.confirm(
        'Delete ALL your data — chats, memory, captures, meetings, and generated images? This cannot be undone. (Installed models are kept.)'
      )
    )
      return
    if (
      !window.confirm(
        'Are you absolutely sure? This permanently erases your personal data on this device.'
      )
    )
      return
    setBusy('all')
    try {
      await api.deleteAllData()
      await refresh()
      // Reload so every screen reflects the wiped state.
      setTimeout(() => window.location.reload(), 300)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 font-mono">
      <div className="border-b border-neutral-800/60 px-4 py-3 text-[10px] font-medium uppercase tracking-widest text-neutral-500">
        Your data on this device
      </div>

      <div className="divide-y divide-neutral-800/40">
        {cats.map((c) => {
          const size = fmtBytes(c.bytes)
          const meta = [
            c.count != null ? `${c.count.toLocaleString()} item${c.count === 1 ? '' : 's'}` : null,
            size
          ]
            .filter(Boolean)
            .join(' · ')
          return (
            <div key={c.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-neutral-200">{c.label}</div>
                <div className="text-[11px] text-neutral-500">
                  {c.detail}
                  {meta ? ` — ${meta}` : ''}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {ARCHIVABLE_CATEGORIES.includes(c.id) ? (
                  <button
                    onClick={() => toggleBackupFirst(c.id)}
                    disabled={busy === c.id}
                    aria-pressed={backupFirst.has(c.id)}
                    aria-label={`Back up ${c.label} before deleting`}
                    title="Save a ZIP backup to a location you pick before anything is deleted"
                    className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] transition-colors disabled:opacity-30 ${
                      backupFirst.has(c.id)
                        ? 'border-green-500/60 text-green-500'
                        : 'border-neutral-800 text-neutral-500 hover:border-neutral-600 hover:text-neutral-300'
                    }`}
                  >
                    <Archive className="h-3 w-3" /> Back up first
                  </button>
                ) : null}
                {RETENTION[c.id]?.map((r) => (
                  <button
                    key={r.days}
                    onClick={() => clearOne(c, r.days)}
                    disabled={busy === c.id || (!c.count && !c.bytes)}
                    className="rounded-md border border-neutral-800 px-2 py-1 text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200 disabled:opacity-30"
                  >
                    {r.label}
                  </button>
                ))}
                <button
                  onClick={() => clearOne(c)}
                  disabled={busy === c.id || (!c.count && !c.bytes)}
                  aria-label={`Delete all ${c.label}`}
                  className="flex items-center gap-1.5 rounded-md border border-neutral-700 px-2.5 py-1 text-[10px] text-neutral-300 transition-colors hover:border-red-500/60 hover:text-red-400 disabled:opacity-30"
                >
                  <Trash className="h-3 w-3" />{' '}
                  {busy === c.id
                    ? backupFirst.has(c.id)
                      ? 'Backing up…'
                      : 'Clearing…'
                    : RETENTION[c.id]
                      ? 'All'
                      : 'Clear'}
                </button>
              </div>
            </div>
          )
        })}
        {cats.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-neutral-600">Reading…</div>
        )}
      </div>

      {/* Automatic history cleanup */}
      {auto ? (
        <div className="border-t border-neutral-800/60 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs text-neutral-200">Automatic cleanup</div>
              <div className="text-[11px] text-neutral-500">
                Keep screen captures for a window - older ones are archived to a folder you pick
                (optional), then removed. Runs daily.
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {RETENTION_CHOICES.map((choice) => (
                <button
                  key={choice.days}
                  onClick={() => saveAutoCleanup({ ...auto.config, retentionDays: choice.days })}
                  disabled={busy === 'auto-cleanup'}
                  aria-pressed={auto.config.retentionDays === choice.days}
                  className={`rounded-md border px-2 py-1 text-[10px] transition-colors disabled:opacity-30 ${
                    auto.config.retentionDays === choice.days
                      ? 'border-green-500/60 text-green-500'
                      : 'border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200'
                  }`}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </div>
          {auto.config.retentionDays > 0 ? (
            <div className="mt-2 flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-1.5">
                <button
                  onClick={async () => {
                    const dir = await api.pickArchiveDir()
                    if (dir) await saveAutoCleanup({ ...auto.config, archiveDir: dir })
                  }}
                  disabled={busy === 'auto-cleanup'}
                  title={auto.config.archiveDir ?? 'Choose where archives are saved'}
                  className="flex min-w-0 items-center gap-1.5 rounded-md border border-neutral-800 px-2 py-1 text-[10px] text-neutral-400 transition-colors hover:border-neutral-600 hover:text-neutral-200 disabled:opacity-30"
                >
                  <FolderOpen className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {auto.config.archiveDir
                      ? `Back up to ${auto.config.archiveDir.split('/').pop()}`
                      : 'No backup - choose a folder'}
                  </span>
                </button>
                {auto.config.archiveDir ? (
                  <button
                    onClick={() => saveAutoCleanup({ ...auto.config, archiveDir: null })}
                    disabled={busy === 'auto-cleanup'}
                    aria-label="Stop backing up before cleanup"
                    className="rounded-md border border-neutral-800 p-1 text-neutral-500 transition-colors hover:border-neutral-600 hover:text-neutral-300 disabled:opacity-30"
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {auto.lastRun ? (
                  <span
                    className={`text-[10px] ${auto.lastRun.status === 'failed' ? 'text-red-400' : 'text-neutral-600'}`}
                  >
                    {auto.lastRun.status === 'failed'
                      ? `Last run failed - nothing was deleted. ${auto.lastRun.error ?? ''}`
                      : `Last run ${new Date(auto.lastRun.ranAt).toLocaleString()} - ${auto.lastRun.archivedFiles ?? 0} file${(auto.lastRun.archivedFiles ?? 0) === 1 ? '' : 's'} archived`}
                  </span>
                ) : null}
                <button
                  onClick={runCleanupNow}
                  disabled={busy === 'auto-cleanup'}
                  className="flex items-center gap-1.5 rounded-md border border-neutral-700 px-2.5 py-1 text-[10px] text-neutral-300 transition-colors hover:border-green-500/60 hover:text-green-500 disabled:opacity-30"
                >
                  <ArrowsClockwise className="h-3 w-3" />
                  {busy === 'auto-cleanup' ? 'Running…' : 'Run now'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Full reset */}
      <div className="flex items-center justify-between gap-3 border-t border-neutral-800/60 px-4 py-3">
        <div className="flex items-center gap-2 text-[11px] text-neutral-500">
          <Warning className="h-3.5 w-3.5 shrink-0" />
          Erase everything personal. Installed models are kept.
        </div>
        <button
          onClick={deleteEverything}
          disabled={busy === 'all'}
          className="shrink-0 whitespace-nowrap rounded-md border border-red-500/40 px-3 py-1.5 text-[11px] text-red-400 transition-colors hover:bg-red-500/10 disabled:opacity-50"
        >
          {busy === 'all' ? 'Deleting…' : 'Delete all my data'}
        </button>
      </div>
    </div>
  )
}
