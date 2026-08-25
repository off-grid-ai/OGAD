/**
 * Compatibility mount for the old in-chat Computer Use overlay.
 *
 * The app-root task side panel now owns Web Use and Computer Use tabs. Keep
 * this inert export until MemoryChat's import is removed in its next isolated
 * refactor; rendering a second panel here would duplicate task state and UI.
 */
export function VisionSupervisorOverlay(): null {
  return null
}
