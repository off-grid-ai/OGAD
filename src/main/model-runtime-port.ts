import type { ResidentReclaim, RuntimeModality } from '@offgrid/models'

/** Desktop-native runtime boundary. Shared owns policy; these operations perform host I/O. */
export interface DesktopManagedRuntime {
  readonly modality: RuntimeModality
  /**
   * Release this runtime's memory, and SAY whether it happened.
   *
   * This used to be `Promise<void> | void`, which is not an answer: three of the four wrappers
   * detected a failed release and had nowhere to report it, so residency counted the memory as
   * reclaimed no matter what the engine did and could admit the next model into memory nobody had
   * released. `{ reclaimed: false }` keeps the resident on residency's books, so the budget stays
   * truthful and the next admission is refused by arithmetic.
   *
   * `{ reclaimed: true }` INCLUDES "there was nothing loaded": an engine holding nothing has no
   * memory to release, and answering false there would strand a phantom resident forever.
   */
  evict(): Promise<ResidentReclaim>
  warm(): Promise<void> | void
  release(): Promise<void> | void
}
