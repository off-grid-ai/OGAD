import { useCallback, useEffect, useState } from 'react'
import { Trash, Warning } from '@phosphor-icons/react'

interface DataCategory {
  id: 'chats' | 'memories' | 'captures' | 'meetings' | 'images'
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

  const refresh = useCallback(async () => {
    try {
      const c = await api.getDataSummary()
      if (Array.isArray(c)) setCats(c as DataCategory[])
    } catch {
      /* keep last */
    }
  }, [api])

  useEffect(() => {
    const load = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(load)
  }, [refresh])

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
                  {busy === c.id ? 'Clearing…' : RETENTION[c.id] ? 'All' : 'Clear'}
                </button>
              </div>
            </div>
          )
        })}
        {cats.length === 0 && (
          <div className="px-4 py-6 text-center text-xs text-neutral-600">Reading…</div>
        )}
      </div>

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
