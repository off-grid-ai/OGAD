import type { ModelModality, RuntimeModel, SpeechPlatformPorts } from '@offgrid/application'
import type { SpeechModel } from '@offgrid/speech'
import { getSetting, saveSetting } from '../database'
import { desktopModelSelectionPersistence } from '../model-selection-persistence'
import { DesktopModelsOperationError, desktopModels } from './application-access'

type SpeechModality = Extract<ModelModality, 'transcription' | 'voice'>

/**
 * The only model routing this port needs. It used to hold the desktop `ModelWorkspace` INSTANCE,
 * which made it a second holder of the workspace beside the composition root - so the Models arm
 * could never be reduced to a ports bundle without handing the app two routing/residency owners.
 * Now the three capabilities come from the Models FACADE, and this narrow shape keeps the module
 * unit-testable without a workspace, a database or the application root.
 */
export interface SpeechModelRouting {
  /** The persisted route identity for a speech modality, or null when nothing is selected. */
  activeRoute(modality: SpeechModality): string | null
  lookup(routeId: string): RuntimeModel | null
  select(modality: SpeechModality, routeId: string | null): Promise<void>
}

/**
 * The canonical selection file is safe to read while the application is being composed. Looking
 * through the application facade at that point creates a cycle: Speech waits for Models, while the
 * facade cannot exist until Speech construction finishes. Writes and model descriptions still go
 * through the Models facade after composition, so Models remains the only runtime routing owner.
 */
const facadeRouting: SpeechModelRouting = {
  activeRoute: (modality) => desktopModelSelectionPersistence.read(modality),
  lookup: (routeId) => desktopModels.lookup(routeId),
  async select(modality, routeId) {
    const outcome = await desktopModels.select({ modality, modelId: routeId })
    // The port's apply/rollback compensation is driven by a throw, so a typed failure must not be
    // swallowed into a silent no-op selection.
    if (!outcome.ok) throw new DesktopModelsOperationError(outcome.failure)
  }
}

type SelectionPort = SpeechPlatformPorts['selection']
type Selection = Awaited<ReturnType<SelectionPort['read']>>

interface SelectionStep {
  apply(): void | Promise<void>
  rollback(): void | Promise<void>
}

const describeModel = (
  routing: SpeechModelRouting,
  modality: 'stt' | 'tts',
  routeId: string
): SpeechModel | null => {
  const model = routing.lookup(routeId)
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
  routing: SpeechModelRouting = facadeRouting
): SelectionPort {
  const read = async (): Promise<Selection> => ({
    stt: routing.activeRoute('transcription'),
    tts: routing.activeRoute('voice'),
    voice: getSetting<string>('ttsVoice', '') || null
  })

  return {
    read,
    async write(next) {
      const previous = await read()
      const steps: SelectionStep[] = []
      if (next.stt !== previous.stt) {
        steps.push({
          apply: () => routing.select('transcription', next.stt),
          rollback: () => routing.select('transcription', previous.stt)
        })
      }
      if (next.tts !== previous.tts) {
        steps.push({
          apply: () => routing.select('voice', next.tts),
          rollback: () => routing.select('voice', previous.tts)
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
    describe: (modality, routeId) => describeModel(routing, modality, routeId)
  }
}
