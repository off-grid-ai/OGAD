/**
 * The pure decision for the on-demand grounder swap, kept Electron-free so it is
 * unit-testable (grounder-loader itself reloads llama-server and can't be).
 *
 * A computer-use run wants a GUI-grounding model loaded. Three cases:
 *  - the active model is ALREADY a grounder  -> run as-is, pay no swap
 *  - the dedicated grounder IS downloaded     -> swap it in, restore the chat model after
 *  - the dedicated grounder is NOT downloaded -> fall back to the active model rather
 *    than hard-failing the whole task on a missing model. The host warns the user the
 *    active model is not a grounder (clicks may be less precise); downloading the
 *    grounder is the accurate path.
 */
export type GrounderPlan = 'use-active-grounder' | 'swap-in-grounder' | 'fallback-active-model'

export function resolveGrounderPlan(
  alreadyGrounder: boolean,
  grounderDownloaded: boolean
): GrounderPlan {
  if (alreadyGrounder) {
    return 'use-active-grounder'
  }
  return grounderDownloaded ? 'swap-in-grounder' : 'fallback-active-model'
}
