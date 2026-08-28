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
import type { ToolContext, ToolExtension, ToolResult } from '../tools'
import type { ProposeOutcome, TickOutcome } from '@offgrid/use'
import { proposeActionApproval, shouldGate, type ActionApprovalRequest } from '../actions/approval'
import { getActionsRuntime } from '../actions/use-runtime'
import { llm } from '../llm'
import { grounderNudgeForQueuedTask } from '../vision/vision-model-notice'
import { emitVisionNotice } from '../vision/vision-controller'
import { getAxRailHost } from '../accessibility/ax-host'
import { axRailViable } from '../accessibility/ax-router'
import { isProEntitled } from '../licensing/license-service'
import { makeWinInlineRunner } from '../actions/semantic-rail-win'
import { runNativeAction } from '../actions/native-helper'
import type { NativeActionCommand, NativeActionResponse } from '../actions/native-helper-logic'
import {
  actionTypeForTool,
  buildNativeToolSchemas,
  canonicalNativeToolName,
  findNativeToolSpec,
  isTaskAction,
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
  /** Browser Use and Computer Use are paid capabilities. */
  isProEntitled: () => boolean
  actions?: ActionsPort
  /** Called when a computer_task is queued: warns the chat, at queue time, if
   *  the loaded model is not a grounder AND the task will fall to the vision
   *  rail (an AX-drivable app needs no grounder). Takes the goal so it can check
   *  AX viability for the target app. Injected so the broadcast is faked in
   *  tests. */
  announceComputerTask?: (goal: string) => void
}

/** How long the tool waits for a free-build action to finish before calling
 *  it pending (the helper's own timeout is 20s). */
const OUTCOME_WAIT_MS = 30_000

function engineResult(actionType: string, text: string): string | ToolResult {
  return isTaskAction(actionType) ? { text, authoritative: true } : text
}

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
  isProEntitled,
  get actions(): ActionsPort {
    // The import is static (the main bundle is one CJS chunk); the runtime
    // itself builds lazily on first access, once the DB exists.
    return getActionsRuntime()
  },
  announceComputerTask: (goal: string) => {
    const model = llm.activeModelInfo()
    // AX-first: if the accessibility rail can drive the target app, the task
    // needs no grounder - so resolve AX viability first, THEN decide the nudge.
    // Fire-and-forget so queuing is never blocked; any AX error nudges as before
    // (assume vision will run).
    void getAxRailHost()
      .routingSnapshot(goal)
      .then((routing) => routing !== null && axRailViable(routing.snapshot))
      .catch(() => false)
      .then((axWillDrive) => {
        const notice = grounderNudgeForQueuedTask(model, axWillDrive)
        if (notice) {
          emitVisionNotice(notice)
        }
      })
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
    return buildNativeToolSchemas(specsForPlatform(this.platform, this.boundary.isProEntitled()))
  }

  /** What the Tools settings tab lists and toggles. A getter, not a field: the set depends on the
   *  platform and the live pro entitlement, so a value captured at construction would keep showing
   *  a stale list after an upgrade. Without this the extension contributed nothing to listTools(),
   *  which is why every native action - web_use and computer_task included - was invisible and
   *  untoggleable in Settings even while the model could call it. */
  get settings(): readonly { name: string; description: string }[] {
    return specsForPlatform(this.platform, this.boundary.isProEntitled()).map((spec) => ({
      name: spec.name,
      description: spec.description
    }))
  }

  canHandle(name: string): boolean {
    const canonicalName = canonicalNativeToolName(name)
    return specsForPlatform(this.platform, this.boundary.isProEntitled()).some(
      (spec) => spec.name === canonicalName
    )
  }

  systemHint(): string {
    return systemHintForPlatform(this.platform, this.boundary.isProEntitled())
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    context?: ToolContext
  ): Promise<string | ToolResult> {
    const canonicalName = canonicalNativeToolName(name)
    if (isTaskAction(canonicalName) && !this.boundary.isProEntitled()) {
      return {
        text: 'Error: Browser Use and Computer Use require Off Grid AI Pro.',
        authoritative: true
      }
    }
    const spec = this.canHandle(canonicalName) ? findNativeToolSpec(canonicalName) : undefined
    if (!spec) {
      return `Error: unknown action ${name}`
    }
    if (shouldGate(spec.risk)) {
      const actionType = actionTypeForTool(canonicalName)
      const actions = this.boundary.actions
      // web_use and computer_task are engine-only: no connector runs them, so
      // they must not fall to the legacy queue even when a pro hook is listening
      // (with B4 the pro queue resolves the engine gate anyway). Other actions
      // keep the legacy path when a pro queue owns approvals.
      const engineOnly = actionType !== undefined && isTaskAction(actionType)
      if (actions && actionType && (engineOnly || !actions.approvalHookActive())) {
        return this.executeViaEngine(actions, actionType, spec, args, context?.conversationId)
      }
      if (engineOnly) {
        return {
          text: 'Error: this task needs the on-device action engine, which is not available here.',
          authoritative: true
        }
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
    args: Record<string, unknown>,
    sourceRef?: string
  ): Promise<string | ToolResult> {
    const reply = (text: string): string | ToolResult => engineResult(actionType, text)
    const proposed = await actions.propose(
      {
        type: actionType,
        intent: spec.title(args),
        args: spec.buildArgs(args),
        risk: spec.risk
      },
      { source: 'chat', ...(sourceRef ? { sourceRef } : {}) }
    )
    if (!proposed.accepted) {
      return reply(`Error: the action was refused: ${proposed.reason}`)
    }
    const taskReference = isTaskAction(actionType) ? ` Task reference: ${proposed.id}.` : ''
    if (proposed.deduped) {
      return reply(
        `That exact action is already queued — not queuing a duplicate. Tell the user it is already in flight.${taskReference}`
      )
    }
    // A computer_task is now queued: warn the chat at queue time only if the
    // loaded model can't ground AND the task will fall to vision (an AX-drivable
    // app needs no grounder). Pass the goal so AX viability can be checked.
    if (actionType === 'computer_task') {
      const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal : spec.title(args)
      console.log(`[computer-task] queued (awaiting approval) goal="${goal}"`)
      this.boundary.announceComputerTask?.(goal)
    }
    actions.kick()
    const raced = await Promise.race([
      actions
        .waitForOutcome(proposed.id, OUTCOME_WAIT_MS)
        .then((outcome) => ({ kind: 'outcome' as const, outcome })),
      actions.whenParked(proposed.id).then(() => ({ kind: 'parked' as const }))
    ])
    if (raced.kind === 'parked') {
      return reply(
        `Queued for the user's approval — ${spec.title(args)} will run only after they approve it. Do not assume it has happened; tell the user it's pending approval.${taskReference}`
      )
    }
    if (!raced.outcome) {
      // Approved and still running past the wait window - NOT queued. Say so, or
      // the model wrongly tells the user to approve something already in flight.
      return reply(
        `"${spec.title(args)}" is running now and will finish shortly. It does NOT need approval - do not tell the user to approve it.${taskReference}`
      )
    }
    const outcome = raced.outcome
    switch (outcome.outcome) {
      case 'done':
        return reply(`${spec.formatResult(undefined)}${taskReference}`)
      case 'rejected':
        return reply(`The user declined — ${spec.title(args)} was not run.${taskReference}`)
      case 'needs_help': {
        const lastAttempt = outcome.record.attemptLog.at(-1)
        const detail = lastAttempt?.detail ? ` (${lastAttempt.detail})` : ''
        return reply(
          `It ran but could not be confirmed${detail}. Tell the user it needs their attention.${taskReference}`
        )
      }
      case 'edited':
        return reply(
          `The user is editing this action before approving it. Tell them it is pending.${taskReference}`
        )
      case 'poisoned':
        return reply(`Error: ${outcome.error}${taskReference}`)
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
