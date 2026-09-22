// Native semantic actions as a chat tool extension (core, macOS). Registered into the
// chat tool loop via registerToolExtension. Exposes calendar / reminders / contacts /
// messages / mail / open_url as model tools that run through the native actions helper.
//
// Chat is the source-policy owner for these tools: every mutation becomes a durable
// Action through the @offgrid/use engine and runs without creating a second approval
// owner. Outside-Chat proposals enter the engine through the Actions surface, whose gate
// remains responsible for approval. Reads and navigation stay inline.

import { shell } from 'electron'
import type { ToolCallStatus, ToolContext, ToolExtension, ToolResult } from '../tools'
import type { ProposeOutcome, TickOutcome } from '@offgrid/use'
import { shouldGate } from '../actions/approval'
import { getActionsRuntime } from '../actions/use-runtime'
import { isProEntitled } from '../licensing/license-service'
import { makeWinInlineRunner } from '../actions/semantic-rail-win'
import { runPowerShell } from '../actions/win-powershell'
import { runNativeAction } from '../actions/native-helper'
import type { NativeActionCommand, NativeActionResponse } from '../actions/native-helper-logic'
import {
  actionTypeForTool,
  buildNativeToolSchemas,
  findNativeToolSpec,
  isTaskAction,
  specsForPlatform,
  systemHintForPlatform,
  taskSessionLimitMinutes,
  type NativeToolSpec
} from './nativeActionToolExtension-logic'
import { createHash } from 'node:crypto'
import { actionArgsWithTaskLaunch } from '../tasks/task-launch-identity'

/** The engine port the extension needs - implemented by the actions runtime,
 *  faked in tests. Optional: absent means the legacy path only. */
export interface ActionsPort {
  propose(input: unknown, meta: { source: 'chat' }): Promise<ProposeOutcome>
  waitForOutcome(actionId: string, timeoutMs: number): Promise<TickOutcome | undefined>
  whenParked(actionId: string): Promise<void>
  kick(): void
}

export interface NativeActionToolBoundary {
  run: (cmd: NativeActionCommand) => Promise<NativeActionResponse>
  /** Browser Use and Computer Use are paid capabilities. */
  isProEntitled: () => boolean
  actions?: ActionsPort
}

/** How long a short native action may keep the model turn open. Web Use and
 * Computer Use return as soon as their durable task has started. */
const OUTCOME_WAIT_MS = 30_000

function taskGoalWithConversation(goal: unknown, context: ToolContext | undefined): string {
  const summary = typeof goal === 'string' ? goal.trim() : ''
  const currentRequest = context?.userQuery?.trim() ?? ''
  const completedPrerequisites = context?.completedPrerequisites?.filter(Boolean) ?? []
  const sections = [
    currentRequest ? `Current user request (authoritative):\n${currentRequest}` : '',
    completedPrerequisites.length
      ? `Completed prerequisites (already done; continue from this state):\n${completedPrerequisites.map((item) => `- ${item}`).join('\n')}`
      : '',
    summary && summary.toLowerCase() !== 'placeholder' && summary !== currentRequest
      ? `Structured task summary:\n${summary}`
      : ''
  ].filter(Boolean)
  return sections.join('\n\n') || summary
}

function engineResult(
  actionType: string,
  text: string,
  status: ToolCallStatus = 'completed',
  authoritative = true
): string | ToolResult {
  return isTaskAction(actionType)
    ? { text, status, ...(authoritative ? { authoritative: true } : {}) }
    : text
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
    }, runPowerShell)
  }
  return runNativeAction
}

const inlineRun = inlineRunnerForPlatform(process.platform)

function currentCoordinates(result: unknown): { latitude: number; longitude: number } | undefined {
  if (!result || typeof result !== 'object') return undefined
  const latitude = (result as Record<string, unknown>).latitude
  const longitude = (result as Record<string, unknown>).longitude
  return typeof latitude === 'number' &&
    Number.isFinite(latitude) &&
    typeof longitude === 'number' &&
    Number.isFinite(longitude)
    ? { latitude, longitude }
    : undefined
}

function needsCurrentLocation(args: Record<string, unknown>, context?: ToolContext): boolean {
  const text = [typeof args.goal === 'string' ? args.goal : '', context?.userQuery ?? ''].join('\n')
  if (
    /\blatitude\s*[:=]?\s*-?\d+(?:\.\d+)?[^\n]*\blongitude\s*[:=]?\s*-?\d+(?:\.\d+)?/i.test(text)
  ) {
    return false
  }
  return /\b(?:near me|my (?:current )?location|current location|device location)\b/i.test(text)
}

const productionBoundary: NativeActionToolBoundary = {
  run: inlineRun,
  isProEntitled,
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
    return buildNativeToolSchemas(specsForPlatform(this.platform, this.boundary.isProEntitled()))
  }

  /** What the Tools settings tab lists and toggles. A getter, not a field: the set depends on the
   *  platform and the live pro entitlement, so a value captured at construction would keep showing
   *  a stale list after an upgrade. Without this the extension contributed nothing to listTools(),
   *  which is why every native action - web_use and computer_use included - was invisible and
   *  untoggleable in Settings even while the model could call it. */
  get settings(): readonly { name: string; description: string }[] {
    return specsForPlatform(this.platform, this.boundary.isProEntitled()).map((spec) => ({
      name: spec.name,
      description: spec.description
    }))
  }

  canHandle(name: string): boolean {
    return specsForPlatform(this.platform, this.boundary.isProEntitled()).some(
      (spec) => spec.name === name
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
    if (isTaskAction(name) && !this.boundary.isProEntitled()) {
      return {
        text: 'Error: Browser Use and Computer Use require Off Grid AI Pro.',
        status: 'failed',
        authoritative: true
      }
    }
    const spec = this.canHandle(name) ? findNativeToolSpec(name) : undefined
    if (!spec) {
      return `Error: unknown action ${name}`
    }
    if (name === 'computer_use' && args.sessionLimitMinutes === undefined) {
      const sessionLimitMinutes = taskSessionLimitMinutes(context?.userQuery)
      if (sessionLimitMinutes) args = { ...args, sessionLimitMinutes }
    }
    if (isTaskAction(name) && needsCurrentLocation(args, context)) {
      const location = context?.currentLocation
      if (!location) {
        return {
          text: context?.currentLocationFailed
            ? 'I could not get your current location. Provide a starting address or neighborhood before I start this nearby task.'
            : 'I need your current coordinates before I start this nearby task. I did not start Web Use.',
          status: 'failed',
          authoritative: true
        }
      }
      args = {
        ...args,
        goal: `${typeof args.goal === 'string' ? args.goal : ''}\n\nStart from latitude ${location.latitude}, longitude ${location.longitude}.`
      }
    }
    if (shouldGate(spec.risk)) {
      const actionType = actionTypeForTool(name)
      const actions = this.boundary.actions
      // This extension is a Chat surface. Every mapped mutation goes through the
      // durable engine even when Pro has registered its outside-Chat approval hook.
      if (actions && actionType) {
        return this.executeViaEngine(actions, actionType, spec, args, context)
      }
      const text = 'Error: this action needs the on-device action engine, which is not available.'
      return isTaskAction(actionType ?? '') ? { text, status: 'failed', authoritative: true } : text
    }
    if (!spec.command) return `Error: ${name} has no inline command.`
    const res = await this.boundary.run({ command: spec.command, args: spec.buildArgs(args) })
    if (!res.ok) {
      if (name === 'get_current_location' && context) context.currentLocationFailed = true
      return `Error: ${res.error}`
    }
    if (name === 'get_current_location' && context) {
      const coordinates = currentCoordinates(res.result)
      if (coordinates) context.currentLocation = coordinates
      else context.currentLocationFailed = true
    }
    if (name === 'open_url' && context && typeof args.url === 'string' && args.url.trim()) {
      context.completedPrerequisites = [
        ...(context.completedPrerequisites ?? []),
        `open_url opened ${args.url.trim()} in the user's default browser`
      ]
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
    context?: ToolContext
  ): Promise<string | ToolResult> {
    const reply = (
      text: string,
      status?: ToolCallStatus,
      authoritative = true
    ): string | ToolResult => engineResult(actionType, text, status, authoritative)
    const builtArgs = spec.buildArgs(args)
    const cleanArgs = isTaskAction(actionType)
      ? { ...builtArgs, goal: taskGoalWithConversation(builtArgs.goal, context) }
      : builtArgs
    const proposed = await actions.propose(
      {
        type: actionType,
        intent: spec.title(args),
        args: actionArgsWithTaskLaunch(cleanArgs, context?.taskLaunch),
        risk: spec.risk
      },
      {
        source: 'chat',
        ...(context?.conversationId ? { sourceRef: context.conversationId } : {}),
        ...(context?.taskLaunch
          ? {
              idempotencyKey: `${actionType}:${createHash('sha256')
                .update(JSON.stringify(cleanArgs))
                .digest('hex')}`
            }
          : {})
      }
    )
    if (!proposed.accepted) {
      return reply(`Error: the action was refused: ${proposed.reason}`, 'failed')
    }
    const taskReference = isTaskAction(actionType) ? `Task reference: ${proposed.id}. ` : ''
    if (proposed.deduped) {
      return reply(
        `${taskReference}A matching task is already in flight. No duplicate was started.`,
        'pending'
      )
    }
    actions.kick()
    if (isTaskAction(actionType)) {
      const label = actionType === 'computer_use' ? 'Computer Use' : 'Web Use'
      return reply(
        `${taskReference}${label} started. Live progress and the final result will appear in this chat. Do not call ${actionType} again for this goal.`,
        'pending'
      )
    }
    const raced = await Promise.race([
      actions
        .waitForOutcome(proposed.id, OUTCOME_WAIT_MS)
        .then((outcome) => ({ kind: 'outcome' as const, outcome })),
      actions.whenParked(proposed.id).then(() => ({ kind: 'parked' as const }))
    ])
    if (raced.kind === 'parked') {
      return reply(
        `${taskReference}Error: the action engine held this Chat action instead of starting it. No approval was created.`,
        'failed'
      )
    }
    if (!raced.outcome) {
      // Approved and still running past the wait window - NOT queued. Say so, or
      // the model wrongly tells the user to approve something already in flight.
      return reply(
        `${taskReference}"${spec.title(args)}" is running now and will finish shortly. It does NOT need approval - do not tell the user to approve it.`,
        'pending'
      )
    }
    const outcome = raced.outcome
    switch (outcome.outcome) {
      case 'done':
        return reply(`${taskReference}${spec.formatResult(undefined)}`)
      case 'rejected':
        return reply(
          `${taskReference}The user declined — ${spec.title(args)} was not run.`,
          'failed'
        )
      case 'needs_help': {
        const lastAttempt = outcome.record.attemptLog.at(-1)
        const detail = lastAttempt?.detail ? ` (${lastAttempt.detail})` : ''
        return reply(
          `${taskReference}It ran but could not be confirmed${detail}. Tell the user it needs their attention.`,
          'pending'
        )
      }
      case 'edited':
        return reply(
          `${taskReference}The user is editing this action before approving it. Tell them it is pending.`,
          'pending'
        )
      case 'poisoned':
        return reply(`${taskReference}Error: ${outcome.error}`, 'failed')
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
