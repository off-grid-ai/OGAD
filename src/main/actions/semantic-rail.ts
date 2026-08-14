/**
 * The semantic rail - the existing native actions helper behind the
 * DeviceController port (R1 box 10).
 *
 * Maps the engine's closed Action types onto the Swift helper's verbs and
 * nothing else: an unknown type is refused, never guessed (file_share and
 * web_task belong to other rails). Pure module - the runner is injected, so
 * tests exercise every mapping through a fake boundary and the Electron-
 * bound runNativeAction is only attached at wiring time.
 */
import type { ActionRecord } from '@offgrid/use'
import type { NativeActionCommand, NativeActionResponse } from './native-helper-logic'

export type RunNativeAction = (cmd: NativeActionCommand) => Promise<NativeActionResponse>

export interface SemanticExecuteResult {
  ok: boolean
  detail?: string
  /** The created item's id (event/reminder) - what undo acts on. */
  effectId?: string
}

/** The helper returns { id } on creates; surface it for undo/audit. */
export function effectIdFrom(result: unknown): string | undefined {
  if (typeof result === 'object' && result !== null) {
    const id = (result as Record<string, unknown>).id
    if (typeof id === 'string' && id.length > 0) {
      return id
    }
  }
  return undefined
}

type MapResult = { ok: true; command: NativeActionCommand } | { ok: false; error: string }

const LOOKUP_COMMANDS: Record<string, string> = {
  contacts: 'contacts.search',
  calendar: 'calendar.listEvents',
  reminders: 'reminders.list'
}

/**
 * Action type -> helper verb. Args pass through: the emission layer (box 12)
 * constrains their shape to what the helper expects per verb.
 */
export function mapActionToCommand(action: Pick<ActionRecord, 'type' | 'args'>): MapResult {
  switch (action.type) {
    case 'calendar':
      return { ok: true, command: { command: 'calendar.createEvent', args: action.args } }
    case 'reminder':
      return { ok: true, command: { command: 'reminders.create', args: action.args } }
    case 'message':
      return { ok: true, command: { command: 'messages.send', args: action.args } }
    case 'email':
      return { ok: true, command: { command: 'mail.send', args: action.args } }
    case 'open':
      return { ok: true, command: { command: 'open_url', args: action.args } }
    case 'lookup': {
      const kind = String(action.args.kind ?? '')
      const command = LOOKUP_COMMANDS[kind]
      if (!command) {
        return {
          ok: false,
          error: `lookup kind '${kind}' is not one of ${Object.keys(LOOKUP_COMMANDS).join(', ')}`
        }
      }
      const { kind: _dropped, ...args } = action.args
      return { ok: true, command: { command, args } }
    }
    default:
      return { ok: false, error: `the semantic rail has no mapping for '${action.type}'` }
  }
}

/** One attempt on the semantic rail. Never throws - failure is a result. */
export function makeSemanticRailExecutor(run: RunNativeAction) {
  return async (action: ActionRecord): Promise<SemanticExecuteResult> => {
    const mapped = mapActionToCommand(action)
    if (!mapped.ok) {
      return { ok: false, detail: mapped.error }
    }
    try {
      const response = await run(mapped.command)
      if (response.ok) {
        return { ok: true, effectId: effectIdFrom(response.result) }
      }
      return { ok: false, detail: response.error }
    } catch (error) {
      return { ok: false, detail: `semantic rail failed: ${(error as Error).message}` }
    }
  }
}
