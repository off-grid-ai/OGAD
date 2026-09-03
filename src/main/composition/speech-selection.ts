import type { SpeechPlatformPorts } from '@offgrid/application'
import type { ModelWorkspace } from '@offgrid/models'
import type { SpeechModel } from '@offgrid/speech'
import { getSetting, saveSetting } from '../database'
import { desktopModelWorkspace } from '../model-services'

type SelectionPort = SpeechPlatformPorts['selection']
type Selection = Awaited<ReturnType<SelectionPort['read']>>

interface SelectionStep {
  apply(): void | Promise<void>
  rollback(): void | Promise<void>
}

const activeRoute = (
  workspace: ModelWorkspace,
  modality: 'transcription' | 'voice'
): string | null => {
  const active = workspace.active(modality)
  return active.selectedRouteId ?? active.selectedId
}

const describeModel = (
  workspace: ModelWorkspace,
  modality: 'stt' | 'tts',
  routeId: string
): SpeechModel | null => {
  const model = workspace.lookup(routeId)
  const expected = modality === 'stt' ? 'transcription' : 'voice'
  if (!model || model.modality !== expected) return null
  return {
    id: routeId,
    kind: modality,
    label: model.name,
    engine: model.providerId ?? model.serverId ?? model.adapterId,
    notes: model.ready ? 'Ready.' : 'Not ready.'
  }
}

async function applySelectionSteps(steps: readonly SelectionStep[]): Promise<void> {
  const applied: SelectionStep[] = []
  try {
    for (const step of steps) {
      // Register compensation first because a platform write can mutate durable state and then fail.
      applied.unshift(step)
      await step.apply()
    }
  } catch (cause) {
    const failures: unknown[] = [cause]
    for (const step of applied) {
      try {
        await step.rollback()
      } catch (rollbackCause) {
        failures.push(rollbackCause)
      }
    }
    if (failures.length === 1) throw cause
    throw new AggregateError(failures, 'Speech selection and rollback failed.')
  }
}

export function createDesktopSpeechSelectionPort(
  workspace: ModelWorkspace = desktopModelWorkspace
): SelectionPort {
  const read = async (): Promise<Selection> => ({
    stt: activeRoute(workspace, 'transcription'),
    tts: activeRoute(workspace, 'voice'),
    voice: getSetting<string>('ttsVoice', '') || null
  })

  return {
    read,
    async write(next) {
      const previous = await read()
      const steps: SelectionStep[] = []
      if (next.stt !== previous.stt) {
        steps.push({
          apply: () => workspace.select('transcription', next.stt),
          rollback: () => workspace.select('transcription', previous.stt)
        })
      }
      if (next.tts !== previous.tts) {
        steps.push({
          apply: () => workspace.select('voice', next.tts),
          rollback: () => workspace.select('voice', previous.tts)
        })
      }
      if (next.voice !== previous.voice) {
        steps.push({
          apply: () => saveSetting('ttsVoice', next.voice ?? ''),
          rollback: () => saveSetting('ttsVoice', previous.voice ?? '')
        })
      }
      await applySelectionSteps(steps)
    },
    describe: (modality, routeId) => describeModel(workspace, modality, routeId)
  }
}
