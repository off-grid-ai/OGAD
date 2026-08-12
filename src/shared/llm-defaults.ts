// Canonical LLM inference defaults - single source of truth shared by the
// backend LLMService field defaults and the Settings UI (Reset to defaults).
//
// DEFAULT_CTX_SIZE is the context-window default. It matches the backend
// LLMService ctxSize field and the `balanced` MODE_PRESET, so a fresh instance
// and what the UI shows agree. Pure constants, no imports.

export const DEFAULT_CTX_SIZE = 16384

// Capture distillation combines the structured prompt, recent activity, accessibility text, and
// vision tokens. An 8K window is the minimum supported runtime envelope; the 16K default above
// leaves output headroom instead of consuming the whole window with input.
export const MIN_CAPTURE_CTX_SIZE = 8192

// Max-output sentinel: the setting value meaning "auto" — let a reply run until the model emits its
// natural stop (EOS) or the context window fills, rather than a fixed token cap that truncated long
// answers. Stored as 0 (a literal 0-token cap is meaningless) and mapped to the engine's unlimited
// (n_predict = -1) at the wire. Single source of truth for the backend and the Settings UI.
export const MAX_TOKENS_AUTO = 0

// Fresh-install / reset default for max output: auto (context is the limit, not a fixed number).
export const DEFAULT_MAX_TOKENS = MAX_TOKENS_AUTO
