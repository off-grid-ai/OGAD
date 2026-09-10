import { useState } from 'react'
import { Broom } from '@phosphor-icons/react'
import type { CacheCleanupResultContract } from '../../../../shared/ipc-contracts'
import { formatStorageBytes } from './storage-format'

/** One cleanup control for disposable cache and inactive model downloads. */
export function CacheCleanupControl(): React.ReactElement {
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const clear = async (): Promise<void> => {
    setBusy(true)
    setNotice(null)
    try {
      const result = (await window.api.clearAppCache()) as CacheCleanupResultContract
      const reclaimed = result.freedBytes
        ? ` ${formatStorageBytes(result.freedBytes)} reclaimed.`
        : ''
      const downloads = result.incompleteDownloadsRemoved
        ? ` ${result.incompleteDownloadsRemoved} partial model download${result.incompleteDownloadsRemoved === 1 ? '' : 's'} removed.`
        : ''
      setNotice(`Temporary cache cleared.${reclaimed}${downloads} Installed models were kept.`)
    } catch {
      setNotice('Cleanup could not be completed. Installed models and your data were kept.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-4 border-t border-neutral-800/60 px-4 py-2.5">
      <div className="min-w-0">
        <div className="text-[11px] text-neutral-300">Temporary app cache</div>
        <div className="text-[10px] text-neutral-600">
          Safe to clear. Partial model downloads are removed. Installed models and your data stay.
        </div>
        {notice && (
          <div role="status" className="mt-1 text-[10px] text-neutral-500">
            {notice}
          </div>
        )}
      </div>
      <button
        onClick={clear}
        disabled={busy}
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-neutral-700 px-2.5 py-1 text-[10px] text-neutral-300 transition-all duration-150 hover:border-green-500/60 hover:text-white active:scale-95 disabled:opacity-50"
      >
        <Broom className="h-3 w-3" /> {busy ? 'Clearing…' : 'Clear cache'}
      </button>
    </div>
  )
}
