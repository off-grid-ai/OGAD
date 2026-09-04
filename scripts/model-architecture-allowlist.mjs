/**
 * Temporary architecture debt only. Each entry is exact: one rule, file, and symbol/import.
 * Remove an entry when its owner moves the policy to @offgrid/models. The gate fails on stale
 * entries so this file cannot become a permanent blanket exception.
 */
export const temporaryModelArchitectureAllowlist = [
  {
    key: 'residency-admission-has-one-owner|src/main/ipc.ts|native lifecycle call outside the residency adapter: llm.restart() on the llama text engine',
    owner: 'Seat D',
    reason:
      'The renderer-reachable `system:restart` handler dynamically imports ./llm and restarts the ' +
      'engine. Same bypass as above and more exposed, because the renderer can trigger it: the ' +
      'model is reloaded with no admission, so residency keeps a stale view of what is resident.',
    removeWhen:
      'the restart command goes through ModelsFacade so residency re-admits the chat model, or the ' +
      'handler is proven to only restart a process that holds no model memory.'
  }
]
