import { useEffect, useState } from 'react'
import { CheckCircleIcon, LightningIcon } from '@phosphor-icons/react'
import { Button } from './ui/button'
import { Collapsible, CollapsibleContent } from './ui/collapsible'
import { deviceNoun } from '@renderer/lib/device'
import type { BestSettingsPlan, MachineProfile } from '../../../shared/best-settings'

interface BestSettingsResult {
  machine: MachineProfile
  plan: BestSettingsPlan
}

type Status =
  | { kind: 'checking' }
  | { kind: 'hidden' }
  | { kind: 'offer' }
  | { kind: 'applying' }
  | { kind: 'done'; machine: MachineProfile }
  | { kind: 'error'; message: string }

// Long enough to read the confirmation before the row slides away.
const CONFIRMATION_MS = 2500

function machineLabel(machine: MachineProfile): string {
  return `${machine.cpuModel}, ${machine.gpu ? `${machine.gpu} GPU` : 'CPU'}`
}

/** One slim row, shown only while this machine is not yet on its fastest settings. */
export function BestSettingsCard({ onApplied }: { onApplied: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<Status>({ kind: 'checking' })
  const device = deviceNoun()

  useEffect(() => {
    let live = true
    const api = window.api as Partial<typeof window.api>
    void (api.bestSettingsStatus?.() ?? Promise.resolve({ applied: true }))
      .then((result: { applied: boolean }) => {
        if (live) setStatus({ kind: result.applied ? 'hidden' : 'offer' })
      })
      .catch(() => {
        if (live) setStatus({ kind: 'hidden' })
      })
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (status.kind !== 'done') return
    const timer = setTimeout(() => setStatus({ kind: 'hidden' }), CONFIRMATION_MS)
    return () => clearTimeout(timer)
  }, [status.kind])

  const apply = async (): Promise<void> => {
    setStatus({ kind: 'applying' })
    try {
      const result = (await window.api.applyBestSettings()) as BestSettingsResult
      setStatus({ kind: 'done', machine: result.machine })
      onApplied()
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : 'The settings could not be applied.'
      })
    }
  }

  const open = status.kind !== 'checking' && status.kind !== 'hidden'
  return (
    <Collapsible open={open}>
      <CollapsibleContent className="offgrid-smooth-collapsible overflow-hidden">
        <div
          role="status"
          aria-label="Fastest settings"
          className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2"
        >
          {status.kind === 'done' ? (
            <p className="flex min-w-0 items-center gap-2 text-xs text-green-500">
              <CheckCircleIcon weight="fill" className="size-4 shrink-0" />
              <span className="truncate">
                Fastest settings on for {machineLabel(status.machine)}
              </span>
            </p>
          ) : status.kind === 'error' ? (
            <p role="alert" className="min-w-0 truncate text-xs text-red-400">
              {status.message}
            </p>
          ) : (
            <p className="min-w-0 truncate text-xs text-neutral-400">
              Run every model on the fastest hardware in this {device}.
            </p>
          )}
          {status.kind === 'done' ? null : (
            <Button
              size="xs"
              onClick={() => void apply()}
              disabled={status.kind === 'applying'}
              className="shrink-0 transition-all duration-150 active:scale-95"
            >
              <LightningIcon weight="fill" />
              {status.kind === 'applying' ? 'Applying…' : 'Use fastest settings'}
            </Button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
