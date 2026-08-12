// Transport-agnostic action-approval seam (core). Every executor that acts on the
// user's behalf — MCP connectors today, computer/GUI actions and the agent browser
// next — classifies each action's risk and, when it is consequential, offers it to
// the approval hook BEFORE doing it. Pro registers the hook to route the action
// through its approval queue + audit log; the free build registers nothing, so the
// action just runs (unchanged free behaviour).
//
// This replaces the MCP-specific `mcp:proposeApproval` hook: the old one carried a
// connector-shaped payload and derived risk from a tool-name regex, neither of
// which generalises to a GUI click (a click is always a write; a screenshot never
// is). Risk is classified per executor via its own riskOf(); the shape below is the
// one thing every executor shares.

import { callHook, hasHook, HOOKS } from '../bootstrap/hookRegistry'

/** How consequential an action is, independent of which executor produced it.
 *  - read: observes only, never changes the world (a screenshot, a list call)
 *  - navigate: moves focus/location without committing (open a URL, scroll)
 *  - mutate: changes state, usually recoverable (send a message, create an event)
 *  - irreversible: cannot be undone (delete, pay, submit, create an account)
 *  read/navigate run freely; mutate/irreversible are offered for approval. */
export type ActionRisk = 'read' | 'navigate' | 'mutate' | 'irreversible'

/** Which executor raised the action — lets the approval UI and audit log group and
 *  label without branching on executor-specific fields. */
export type ActionKind = 'mcp' | 'computer' | 'browser'

export interface ActionApprovalRequest {
  kind: ActionKind
  /** One-line, user-facing summary of what will happen. */
  title: string
  /** Longer context for the approval card (arguments, source surface). */
  detail: string
  risk: ActionRisk
  /** Structured arguments, passed through to the executor on approval. */
  args: Record<string, unknown>
  /** Where the action originated (e.g. 'chat', a skill id). */
  source: string
  /** Executor-specific fields (connectorId/tool for mcp, selector for browser).
   *  Left open so the seam never needs to know each executor's payload shape. */
  [extra: string]: unknown
}

/** mutate and irreversible actions gate; read and navigate run freely. The single
 *  source of truth for the gating rule — executors and tests both call this rather
 *  than re-encoding the set. */
export function shouldGate(risk: ActionRisk): boolean {
  return risk === 'mutate' || risk === 'irreversible'
}

/** Offer an action to the approval hook. Returns true when it was queued (the
 *  caller must NOT execute), false when a handler ran but did not queue it, and
 *  undefined when nothing is listening (free build — execute now).
 *
 *  Falls back to the legacy `mcp:proposeApproval` hook so a pro build that has not
 *  yet migrated keeps gating MCP writes instead of silently running them. hasHook
 *  distinguishes "new handler present" from "new handler returned undefined", so a
 *  registered new handler is always authoritative and the legacy path is only used
 *  when the new name is genuinely unregistered. */
export function proposeActionApproval(request: ActionApprovalRequest): boolean | undefined {
  if (hasHook(HOOKS.actionsProposeApproval)) {
    return callHook<boolean>(HOOKS.actionsProposeApproval, request)
  }
  return callHook<boolean>(HOOKS.legacyMcpProposeApproval, request)
}
