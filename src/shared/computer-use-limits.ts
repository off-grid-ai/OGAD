/**
 * Normal browser and desktop work has no arbitrary action limit. A run ends
 * on success, explicit user stop, a safety boundary, or a real failure.
 * Tests and policy callers can still inject a finite limit when required.
 */
export const DEFAULT_COMPUTER_USE_STEP_BUDGET = Number.POSITIVE_INFINITY

/** Keep the complete normal journey available for the task audit surface. */
export const MAX_COMPUTER_USE_TRACE_STEPS = 250

/** Bound the separated, user-visible model reasoning channel for one step. */
export const MAX_COMPUTER_USE_REASONING_CHARS = 12_000
