// Native semantic actions as a chat tool extension (core, macOS). Registered into the
// chat tool loop via registerToolExtension. Exposes calendar / reminders / contacts /
// messages / mail / open_url as model tools that run through the native actions helper.
//
// Two paths for a mutating tool (R1 box 13):
// - Engine path (free build, no approval hook listening): the mutation becomes a
//   durable Action through the @offgrid/use engine - validated, journaled, executed on
//   the semantic rail, verified - and the tool reports the real outcome.
// - Legacy path (a pro approval queue is listening, or no engine port is wired): the
//   write is offered to the approval seam exactly as before; pro queues it and pro's
//   executor runs it on approve. An unmigrated pro build keeps its behaviour untouched.
// Reads and navigation stay inline on both paths (architecture decision 5).

import type { ToolExtension } from '../tools'
import type { ProposeOutcome, TickOutcome } from '@offgrid/use'
import { proposeActionApproval, shouldGate, type ActionApprovalRequest } from '../actions/approval'
import { getActionsRuntime } from '../actions/use-runtime'
import { runNativeAction } from '../actions/native-helper'
import type { NativeActionCommand, NativeActionResponse } from '../actions/native-helper-logic'
import {
  actionTypeForTool,
  buildNativeToolSchemas,
  findNativeToolSpec,
  NATIVE_TOOL_SPECS,
  type NativeToolSpec
} from './nativeActionToolExtension-logic'

/** The engine port the extension needs - implemented by the actions runtime,
 *  faked in tests. Optional: absent means the legacy path only. */
export interface ActionsPort {
  approvalHookActive(): boolean
  propose(
    input: unknown,
    meta: { source: 'chat' }
  ): Promise<ProposeOutcome>
  waitForOutcome(actionId: string, timeoutMs: number): Promise<TickOutcome | undefined>
  whenParked(actionId: string): Promise<void>
  kick(): void
}

export interface NativeActionToolBoundary {
  run: (cmd: NativeActionCommand) => Promise<NativeActionResponse>
  proposeApproval: (request: ActionApprovalRequest) => boolean | undefined
  actions?: ActionsPort
}

/** How long the tool waits for a free-build action to finish before calling
 *  it pending (the helper's own timeout is 20s). */
const OUTCOME_WAIT_MS = 30_000

const productionBoundary: NativeActionToolBoundary = {
  run: runNativeAction,
  proposeApproval: proposeActionApproval,
  get actions(): ActionsPort {
    // The import is static (the main bundle is one CJS chunk); the runtime
    // itself builds lazily on first access, once the DB exists.
    return getActionsRuntime()
  }
}

export class NativeActionToolExtension implements ToolExtension {
  id = 'native-actions'
  /** The assistant's own on-device abilities, not an external account:
   *  available in every agentic turn, not gated behind Connectors. */
  category = 'tool' as const

  constructor(private readonly boundary: NativeActionToolBoundary = productionBoundary) {}

  schemas(): unknown[] {
    return buildNativeToolSchemas()
  }

  canHandle(name: string): boolean {
    return findNativeToolSpec(name) !== undefined
  }

  systemHint(): string {
    return "You can act on the user's Mac: manage calendar events (calendar_create_event, calendar_list_events) and reminders (reminders_create, reminders_list), look up people (contacts_search), and send an iMessage (messages_send) or email (mail_send). Resolve a name to a handle with contacts_search before sending. Open a link or app scheme (like whatsapp://send) with open_url. Use ISO 8601 for all times. Anything that creates or sends needs the user's approval; tell them it is pending until they approve."
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const spec = findNativeToolSpec(name)
    if (!spec) {
      return `Error: unknown action ${name}`
    }
    if (shouldGate(spec.risk)) {
      const actionType = actionTypeForTool(name)
      const actions = this.boundary.actions
      if (actions && actionType && !actions.approvalHookActive()) {
        return this.executeViaEngine(actions, actionType, spec, args)
      }
      // Legacy path: offer to the approval seam; pro queues and executes.
      const queued = this.boundary.proposeApproval({
        kind: 'native',
        title: spec.title(args),
        detail: `Requested from chat. Arguments: ${JSON.stringify(args)}`,
        risk: spec.risk,
        command: spec.command,
        args,
        source: 'chat'
      })
      if (queued) {
        return `Queued for the user's approval — ${spec.title(args)} will run only after they approve it. Do not assume it has happened; tell the user it's pending approval.`
      }
    }
    const res = await this.boundary.run({ command: spec.command, args: spec.buildArgs(args) })
    if (!res.ok) {
      return `Error: ${res.error}`
    }
    return spec.formatResult(res.result)
  }

  /** The durable path: propose -> the worker drains -> report the REAL
   *  outcome (done / declined / needs help), or pending when gated. */
  private async executeViaEngine(
    actions: ActionsPort,
    actionType: string,
    spec: NativeToolSpec,
    args: Record<string, unknown>
  ): Promise<string> {
    const proposed = await actions.propose(
      {
        type: actionType,
        intent: spec.title(args),
        args: spec.buildArgs(args),
        risk: spec.risk
      },
      { source: 'chat' }
    )
    if (!proposed.accepted) {
      return `Error: the action was refused: ${proposed.reason}`
    }
    if (proposed.deduped) {
      return `That exact action is already queued — not queuing a duplicate. Tell the user it is already in flight.`
    }
    actions.kick()
    const raced = await Promise.race([
      actions
        .waitForOutcome(proposed.id, OUTCOME_WAIT_MS)
        .then((outcome) => ({ kind: 'outcome' as const, outcome })),
      actions.whenParked(proposed.id).then(() => ({ kind: 'parked' as const }))
    ])
    if (raced.kind === 'parked' || !raced.outcome) {
      return `Queued for the user's approval — ${spec.title(args)} will run only after they approve it. Do not assume it has happened; tell the user it's pending approval.`
    }
    const outcome = raced.outcome
    switch (outcome.outcome) {
      case 'done':
        return spec.formatResult(undefined)
      case 'rejected':
        return `The user declined — ${spec.title(args)} was not run.`
      case 'needs_help': {
        const lastAttempt = outcome.record.attemptLog.at(-1)
        const detail = lastAttempt?.detail ? ` (${lastAttempt.detail})` : ''
        return `It ran but could not be confirmed${detail}. Tell the user it needs their attention.`
      }
      case 'edited':
        return `The user is editing this action before approving it. Tell them it is pending.`
      case 'poisoned':
        return `Error: ${outcome.error}`
    }
  }
}

export const nativeActionToolExtension = new NativeActionToolExtension()

/** Register the native-action tools. macOS-only: the helper is an EventKit binary and
 *  simply reports "not available" elsewhere, so gate registration on the platform to
 *  keep the tools out of the grammar budget where they cannot work. */
export function registerNativeActionTools(
  register: (ext: ToolExtension) => void,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform !== 'darwin') {
    return
  }
  if (NATIVE_TOOL_SPECS.length === 0) {
    return
  }
  register(nativeActionToolExtension)
}
