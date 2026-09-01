// Compatibility facade for older Desktop runtime readers. Canonical selection is
// persisted by DesktopModelSelectionPersistence; this API projects its route back
// to the provider-native model id required by existing engines.
import type { Modality } from '@offgrid/models'
import { CORE_SYNC_ENTITIES, emitSyncMutation } from './sync-mutation'
import {
  DesktopModelSelectionPersistence,
  desktopModelSelectionPersistence
} from './model-selection-persistence'
export { isModelActive, modalityForKind, type Modality } from '@offgrid/models'

/** @deprecated Use DesktopModelSelectionPersistence. */
export class ActiveModalityStore extends DesktopModelSelectionPersistence {
  get(kind: Modality): string | null {
    const modality = kind === 'speech' ? 'voice' : kind
    return this.projectedModelId(modality)
  }

  set(kind: Modality, id: string | null): void {
    const modality = kind === 'speech' ? 'voice' : kind
    try {
      this.write(modality, id)
      this.projectLegacyModality(modality, id)
    } catch (error) {
      console.error('[active-models] write failed', error)
    }
  }

  all(): Record<Modality, string | null> {
    return {
      computer_use: this.get('computer_use'),
      image: this.get('image'),
      speech: this.get('speech'),
      transcription: this.get('transcription')
    }
  }
}

const activeModalStore = desktopModelSelectionPersistence

/** The chosen model id for a modality, or null to use the runtime's default. */
export function getActiveModal(kind: Modality): string | null {
  return activeModalStore.projectedModelId(kind === 'speech' ? 'voice' : kind)
}

export function setActiveModal(
  kind: Modality,
  id: string | null,
  options: { emitSync?: boolean } = {}
): void {
  const modality = kind === 'speech' ? 'voice' : kind
  activeModalStore.write(modality, id)
  activeModalStore.projectLegacyModality(modality, id)
  if (kind === 'computer_use' && options.emitSync !== false) {
    emitSyncMutation({
      entity: CORE_SYNC_ENTITIES.modelSetting,
      entityId: 'computerUseModelId',
      kind: 'put',
      fields: { value: id }
    })
  }
}

export function getAllActiveModals(): Record<Modality, string | null> {
  return {
    computer_use: getActiveModal('computer_use'),
    image: getActiveModal('image'),
    speech: getActiveModal('speech'),
    transcription: getActiveModal('transcription')
  }
}
