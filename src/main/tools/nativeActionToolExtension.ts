// Native semantic actions as a chat tool extension (core, macOS). Registered into the
// chat tool loop via registerToolExtension. Exposes calendar (and, as rows are added,
// reminders / contacts / photos) as model tools that run through the native actions
// helper, with mutating tools gated through the shared approval seam - the same
// open-core seam the MCP extension uses. Free build: no approval hook, so a write runs
// directly. Pro: the write queues for approval and the pro executor runs it on approve.

import type { ToolExtension } from '../tools'
import { proposeActionApproval, shouldGate, type ActionApprovalRequest } from '../actions/approval'
import { runNativeAction } from '../actions/native-helper'
import type { NativeActionCommand, NativeActionResponse } from '../actions/native-helper-logic'
import {
  buildNativeToolSchemas,
  findNativeToolSpec,
  NATIVE_TOOL_SPECS
} from './nativeActionToolExtension-logic'

export interface NativeActionToolBoundary {
  run: (cmd: NativeActionCommand) => Promise<NativeActionResponse>
  proposeApproval: (request: ActionApprovalRequest) => boolean | undefined
}

const productionBoundary: NativeActionToolBoundary = {
  run: runNativeAction,
  proposeApproval: proposeActionApproval
}

export class NativeActionToolExtension implements ToolExtension {
  id = 'native-actions'

  constructor(private readonly boundary: NativeActionToolBoundary = productionBoundary) {}

  schemas(): unknown[] {
    return buildNativeToolSchemas()
  }

  canHandle(name: string): boolean {
    return findNativeToolSpec(name) !== undefined
  }

  systemHint(): string {
    return "You can act on the user's Mac: manage calendar events (calendar_create_event, calendar_list_events) and reminders (reminders_create, reminders_list), look up people (contacts_search), and send an iMessage (messages_send) or email (mail_send). Resolve a name to a handle with contacts_search before sending. Use ISO 8601 for all times. Anything that creates or sends needs the user's approval; tell them it is pending until they approve."
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const spec = findNativeToolSpec(name)
    if (!spec) {
      return `Error: unknown action ${name}`
    }
    // Mutating actions offer themselves for approval first; pro queues them.
    if (shouldGate(spec.risk)) {
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
