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

import { shell } from 'electron'
import type { ToolExtension } from '../tools'
import type { ProposeOutcome, TickOutcome } from '@offgrid/use'
import { proposeActionApproval, shouldGate, type ActionApprovalRequest } from '../actions/approval'
import { getActionsRuntime } from '../actions/use-runtime'
import { makeWinInlineRunner } from '../actions/semantic-rail-win'
import { runNativeAction } from '../actions/native-helper'
import type { NativeActionCommand, NativeActionResponse } from '../actions/native-helper-logic'
import {
  actionTypeForTool,
  buildNativeToolSchemas,
  findNativeToolSpec,
  specsForPlatform,
  systemHintForPlatform,
  type NativeToolSpec
} from './nativeActionToolExtension-logic'

/** The engine port the extension needs - implemented by the actions runtime,
 *  faked in tests. Optional: absent means the legacy path only. */
export interface ActionsPort {
  approvalHookActive(): boolean
  propose(input: unknown, meta: { source: 'chat' }): Promise<ProposeOutcome>
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

// The inline (non-engine) runner, picked by platform in exactly one place:
// mac runs the Swift helper; Windows opens links through the shell and
// refuses everything else honestly (reads are not exposed there yet).
// Exported so both arms are testable without faking process.platform.
export function inlineRunnerForPlatform(
  platform: NodeJS.Platform
): (cmd: NativeActionCommand) => Promise<NativeActionResponse> {
  if (platform === 'win32') {
    return makeWinInlineRunner(async (url) => {
      await shell.openExternal(url)
    })
  }
  return runNativeAction
}

const inlineRun = inlineRunnerForPlatform(process.platform)

const productionBoundary: NativeActionToolBoundary = {
  run: inlineRun,
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

  constructor(
    private readonly boundary: NativeActionToolBoundary = productionBoundary,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  schemas(): unknown[] {
    return buildNativeToolSchemas(specsForPlatform(this.platform))
  }

  canHandle(name: string): boolean {
    return specsForPlatform(this.platform).some((spec) => spec.name === name)
  }

  systemHint(): string {
    return systemHintForPlatform(this.platform)
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const spec = this.canHandle(name) ? findNativeToolSpec(name) : undefined
    if (!spec) {
      return `Error: unknown action ${name}`
    }
    if (shouldGate(spec.risk)) {
      const actionType = actionTypeForTool(name)
      const actions = this.boundary.actions
      // web_task and computer_task are engine-only: no connector runs them, so
      // they must not fall to the legacy queue even when a pro hook is listening
      // (with B4 the pro queue resolves the engine gate anyway). Other actions
      // keep the legacy path when a pro queue owns approvals.
      const engineOnly = actionType === 'web_task' || actionType === 'computer_task'
      if (actions && actionType && (engineOnly || !actions.approvalHookActive())) {
        return this.executeViaEngine(actions, actionType, spec, args)
      }
      if (engineOnly) {
        return 'Error: this task needs the on-device action engine, which is not available here.'
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

/** Register the native-action tools where the platform exposes any: macOS (the
 *  Swift helper, the full set) and Windows (the Outlook rail's engine-routed
 *  subset). Elsewhere the spec list is empty, so registration is skipped and
 *  the tools stay out of the grammar budget where they cannot work. */
export function registerNativeActionTools(
  register: (ext: ToolExtension) => void,
  platform: NodeJS.Platform = process.platform
): void {
  if (specsForPlatform(platform).length === 0) {
    return
  }
  register(nativeActionToolExtension)
}
