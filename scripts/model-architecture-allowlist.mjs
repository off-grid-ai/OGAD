/**
 * Temporary architecture debt only. Each entry is exact: one rule, file, and symbol/import.
 * Remove an entry when its owner moves the policy to @offgrid/models. The gate fails on stale
 * entries so this file cannot become a permanent blanket exception.
 *
 * EMPTY, and worth keeping that way. Both original entries were real bypasses of the
 * residency-admission invariant - `guided-setup.ts` and the renderer-reachable `system:restart`,
 * each calling `llm.restart()` to reload the chat model with no admission. Listing them stopped new
 * violations; it did not close these two, and an allowlist is only honest while it is shrinking.
 * They are closed now: guided setup asks for `models.prepare('text')`, and the restart handler asks
 * for `models.restart({ modality: 'text' })`, which releases through residency and refuses if the
 * engine keeps its memory.
 */
export const temporaryModelArchitectureAllowlist = []
