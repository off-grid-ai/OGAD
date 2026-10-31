import { useEffect, useState } from 'react'
import { CheckCircleIcon, LightningIcon } from '@phosphor-icons/react'
import { Button } from './ui/button'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { Collapsible, CollapsibleContent } from './ui/collapsible'
import { deviceNoun } from '@renderer/lib/device'
import type { ModalityPlacement } from '@offgrid/models'
import type { BestSettingsPlan, MachineProfile } from '../../../shared/best-settings'

interface BestSettingsResult {
  machine: MachineProfile
  plan: BestSettingsPlan
  placements?: ModalityPlacement[]
}

type Status =
  | { kind: 'checking' }
  | { kind: 'hidden' }
  | { kind: 'offer' }
  | { kind: 'applying' }
  | { kind: 'done'; machine: MachineProfile; placements: ModalityPlacement[] }
  | { kind: 'error'; message: string }

// Long enough to read the confirmation before the row slides away.
const CONFIRMATION_MS = 2500
// Each modality line adds reading time.
const LINE_MS = 1200

const MODALITY_LABEL: Record<string, string> = {
  llm: 'Text',
  image: 'Image',
  video: 'Video',
  stt: 'Speech to text',
  tts: 'Voice',
  embeddings: 'Search'
}
const PLACE_LABEL: Record<ModalityPlacement['place'], string> = {
  npu: 'NPU',
  gpu: 'GPU',
  cpu: 'CPU'
}

/** One plain line per modality, e.g. "Video: GPU (sd.cpp), loads for each clip". */
function placementLine(placement: ModalityPlacement): string {
  const label = MODALITY_LABEL[placement.modality] ?? placement.modality
  const notes = [
    ...(placement.modality === 'video' ? ['loads for each clip'] : []),
    ...(placement.reason ? [placement.reason] : [])
  ]
  return `${label}: ${PLACE_LABEL[placement.place]} (${placement.engine})${notes.length ? `, ${notes.join(', ')}` : ''}`
}

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
    const lines = status.placements.length
    const timer = setTimeout(() => setStatus({ kind: 'hidden' }), CONFIRMATION_MS + lines * LINE_MS)
    return () => clearTimeout(timer)
  }, [status])

  const apply = async (): Promise<void> => {
    setStatus({ kind: 'applying' })
    try {
      const result = (await window.api.applyBestSettings()) as BestSettingsResult
      setStatus({ kind: 'done', machine: result.machine, placements: result.placements ?? [] })
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
            <div className="flex min-w-0 flex-col gap-1">
              <p className="flex min-w-0 items-center gap-2 text-xs text-green-500">
                <CheckCircleIcon weight="fill" className="size-4 shrink-0" />
                <span className="truncate">
                  Fastest settings on for {machineLabel(status.machine)}
                </span>
              </p>
              {status.placements.length ? (
                <ul aria-label="Where each model runs" className="pl-6 text-xs text-neutral-400">
                  {status.placements.map((placement) => (
                    <li key={placement.modality} className="truncate">
                      {placementLine(placement)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
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
              <TextMorph as="span">
                {status.kind === 'applying' ? 'Applying…' : 'Use fastest settings'}
              </TextMorph>
            </Button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
