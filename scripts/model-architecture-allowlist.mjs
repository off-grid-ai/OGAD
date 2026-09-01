/**
 * Temporary architecture debt only. Each entry is exact: one rule, file, and symbol/import.
 * Remove an entry when its owner moves the policy to @offgrid/models. The gate fails on stale
 * entries so this file cannot become a permanent blanket exception.
 */
export const temporaryModelArchitectureAllowlist = [
  {
    key: 'active-model-writes-use-canonical-selection-port|src/main/ipc.ts|call:m.setActiveModel',
    owner: 'desktop-model-control',
    reason: 'The legacy text-selection IPC handler still calls models-manager directly.',
    removeWhen: 'The handler delegates to DesktopModelServices.select for the canonical text route.',
  },
  {
    key: 'active-model-writes-use-canonical-selection-port|src/main/ipc.ts|call:m.setActiveModalChoice',
    owner: 'desktop-model-control',
    reason: 'The legacy modality-selection IPC handler still calls models-manager directly.',
    removeWhen: 'The handler delegates to DesktopModelServices.select for every modality.',
  },
  {
    key: "adapters-do-not-own-provider-or-reasoning-policy|src/main/llm/remote-chat.ts|branch:remote.provider === 'openrouter'",
    owner: 'desktop-text-runtime',
    reason: 'The remote transport still chooses the OpenRouter HTTP projection itself.',
    removeWhen: 'Shared remote route policy returns the complete transport projection.',
  },
  {
    key: "adapters-do-not-own-provider-or-reasoning-policy|src/main/llm/remote-chat.ts|branch:remote.provider === 'ollama'",
    owner: 'desktop-text-runtime',
    reason: 'The remote transport still chooses the Ollama wire format itself.',
    removeWhen: 'Shared remote route policy returns the complete transport projection.',
  },
  {
    key: "adapters-do-not-own-provider-or-reasoning-policy|src/main/llm/remote-chat.ts|branch:remote.provider !== 'openrouter'",
    owner: 'desktop-text-runtime',
    reason: 'The remote transport still applies an OpenRouter-only header decision.',
    removeWhen: 'Shared remote route policy returns provider-neutral headers.',
  },
  {
    key: "adapters-do-not-own-provider-or-reasoning-policy|src/main/model-generation-adapters.ts|branch:kind === 'reasoning'",
    owner: 'desktop-text-runtime',
    reason: 'The Desktop stream adapter still classifies reasoning chunks locally.',
    removeWhen: 'Shared stream projection returns normalized content and reasoning events.',
  },
  {
    key: 'internal-remote-vision-id-never-reaches-ui|src/renderer/src/components/RemoteVisionSettingsTab.tsx|jsx:model.id',
    owner: 'desktop-remote-model-projection',
    reason: 'The remote model picker still renders the raw inventory ID as secondary text.',
    removeWhen: 'The UI renders only the Shared display-name projection and keeps the route ID opaque.',
  },
]
