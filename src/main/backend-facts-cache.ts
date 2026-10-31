// What backend-facts remembers between reads: cached device answers and the backends a fault
// demoted. A leaf, so the backend choice store can clear it when a choice changes.

import {
  BACKEND_MODALITIES,
  type BackendFacts,
  type BackendModality,
  type NativeBackend
} from '@offgrid/models'

export const demoted: BackendFacts['demoted'] = {}
const probes = new Map<string, Promise<boolean>>()

export function demoteBackend(modality: BackendModality, backend: NativeBackend): void {
  const backends = (demoted[modality] ??= [])
  if (!backends.includes(backend)) backends.push(backend)
}
export function clearDemotions(modality?: BackendModality): void {
  for (const value of modality ? [modality] : BACKEND_MODALITIES) delete demoted[value]
}
/** One device answer per engine, asked once until the facts are invalidated. */
export function cachedProbe(id: string, probe: () => Promise<boolean>): Promise<boolean> {
  let answer = probes.get(id)
  if (!answer) {
    answer = probe()
    probes.set(id, answer)
  }
  return answer
}
/** Forget cached device answers after a pack install, a driver change or wake. */
export function invalidateBackendFacts(): void {
  probes.clear()
}
