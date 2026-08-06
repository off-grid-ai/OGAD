// Canonical LLM inference defaults - single source of truth shared by the
// backend LLMService field defaults and the Settings UI (Reset to defaults).
//
// DEFAULT_CTX_SIZE is the context-window default. It matches the backend
// LLMService ctxSize field and the `balanced` MODE_PRESET, so a fresh instance
// and what the UI shows agree. Pure constants, no imports.

export const DEFAULT_CTX_SIZE = 16384

// The smallest EFFECTIVE context window the on-device capture pipeline needs to distill a
// screen frame into an observation. The distill prompt (system instructions + the KNOWN
// ENTITIES list + up to ~4000 chars of frame text + the reserved output tokens) overflows a
// window near the 2048 clamp floor, which silently stops observations - so Day and Reflect
// never populate. Used to WARN in Settings and to classify the failure, not to hard-block:
// a short frame can still fit under this, and a RAM-constrained machine must not lose capture
// entirely. Keep in sync with the distill prompt budget in pro's crm/extract.ts.
export const MIN_OBSERVATION_CTX = 4096

// Max-output sentinel: the setting value meaning "auto" — let a reply run until the model emits its
// natural stop (EOS) or the context window fills, rather than a fixed token cap that truncated long
// answers. Stored as 0 (a literal 0-token cap is meaningless) and mapped to the engine's unlimited
// (n_predict = -1) at the wire. Single source of truth for the backend and the Settings UI.
export const MAX_TOKENS_AUTO = 0

// Fresh-install / reset default for max output: auto (context is the limit, not a fixed number).
export const DEFAULT_MAX_TOKENS = MAX_TOKENS_AUTO
