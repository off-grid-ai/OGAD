import type { RuntimeModality } from '@offgrid/models'

/** Desktop-native runtime boundary. Shared owns policy; these operations perform host I/O. */
export interface DesktopManagedRuntime {
  readonly modality: RuntimeModality
  evict(): Promise<void> | void
  warm(): Promise<void> | void
  release(): Promise<void> | void
}
