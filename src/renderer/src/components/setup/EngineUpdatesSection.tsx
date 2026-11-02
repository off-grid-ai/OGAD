import { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import type { EngineUpdateStatus } from '../../../../shared/engine-updates'
import { formatStorageBytes } from './storage-format'
import { Switch } from '@offgrid/operator-ui/operator/animate/switch'
import { LiveStatus, SettingRow } from '@offgrid/operator-ui/operator/presence'
import { ArrowsClockwise } from '@phosphor-icons/react'
import { IconTip } from '../IconTip'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'

// Engine ids are the bin folders they replace; the CPU and CUDA variants share a name.
const ENGINE_NAMES: Record<string, string> = {
  llama: 'Chat',
  'llama-prism': 'Bonsai',
  sd: 'Images',
  whisper: 'Transcription'
}

function engineName(id: string): string {
  return ENGINE_NAMES[id.replace(/-(cpu|cuda)$/, '')] ?? id
}

/** One entry per engine when its variants match; each variant's own version when they differ. */
function installedLabels(installed: [string, string][]): string[] {
  const byName = new Map<string, [string, string][]>()
  for (const entry of installed) {
    const name = engineName(entry[0])
    byName.set(name, [...(byName.get(name) ?? []), entry])
  }
  return [...byName].flatMap(([name, variants]) =>
    new Set(variants.map(([, version]) => version)).size === 1
      ? [`${name}: ${variants[0]![1]}`]
      : variants.map(
          ([id, version]) => `${name} (${id.match(/-(cpu|cuda)$/)?.[1] ?? 'GPU'}): ${version}`
        )
  )
}

function phaseText(status: EngineUpdateStatus): string {
  switch (status.phase) {
    case 'checking':
      return 'Checking for newer engines...'
    case 'downloading':
      return status.totalBytes
        ? `Downloading ${formatStorageBytes(status.downloadedBytes)} of ${formatStorageBytes(status.totalBytes)}`
        : 'Downloading...'
    case 'installing':
      return 'Checking the new engine starts...'
    case 'failed':
      return status.error ?? 'The last engine update failed. It will try again later.'
    case 'disabled':
      return 'Engines stay on the version this app shipped with.'
    case 'up-to-date':
      return 'Engines are up to date. A new engine is used the next time a model loads.'
    default:
      return 'Newer engines install in the background.'
  }
}

/** "Keep engines up to date": on by default, so new model support arrives without an app update. */
export function EngineUpdatesSection(): React.ReactElement | null {
  const [status, setStatus] = useState<EngineUpdateStatus | null>(null)

  useEffect(() => {
    const engines = window.api.engineUpdates as Partial<typeof window.api.engineUpdates> | undefined
    if (typeof engines?.status !== 'function') return
    void engines
      .status()
      .then(setStatus)
      .catch(() => {})
    return engines.onChanged?.(setStatus)
  }, [])

  if (!status || status.phase === 'unsupported') return null
  const busy = ['checking', 'downloading', 'installing'].includes(status.phase)
  const installed = Object.entries(status.installed)

  return (
    <div className="mt-4 border-t border-neutral-800 pt-4">
      <SettingRow
        title="Keep engines up to date"
        description="Installs newer chat, image and transcription engines in the background, so new models work without an app update."
        className="py-0"
        toggle={
          <Switch
            aria-label="Keep engines up to date"
            checked={status.enabled}
            onCheckedChange={() =>
              void window.api.engineUpdates.setEnabled(!status.enabled).then(setStatus)
            }
          />
        }
      />
      {busy ? (
        <p role="status" aria-busy="true" className="mt-2 text-[11px] text-neutral-500">
          <TextShimmer as="span">{phaseText(status)}</TextShimmer>
        </p>
      ) : (
        <LiveStatus
          className={`mt-2 text-[11px] ${status.phase === 'failed' ? 'text-red-400' : 'text-neutral-500'}`}
        >
          {phaseText(status)}
        </LiveStatus>
      )}
      {installed.length ? (
        <p className="mt-1 text-[11px] text-neutral-500">
          {installedLabels(installed).join(' · ')}
        </p>
      ) : null}
      {status.enabled ? (
        <IconTip label={busy ? 'Checking...' : 'Check for engine updates'}>
          <Button
            size="icon-xs"
            variant="outline"
            className="mt-3"
            aria-label={busy ? 'Checking...' : 'Check for engine updates'}
            aria-busy={busy || undefined}
            disabled={busy}
            onClick={() => void window.api.engineUpdates.check().then(setStatus)}
          >
            <ArrowsClockwise className={busy ? 'animate-spin' : undefined} />
          </Button>
        </IconTip>
      ) : null}
    </div>
  )
}
