// Pure logic for the native-action tool extension: the table of semantic tools the
// model can call (calendar today; reminders / contacts / photos add as rows), plus
// schema building, risk classification, argument mapping, and result formatting. No
// Electron or process I/O here, so it is unit testable; the extension shell wires it
// to runNativeAction + the approval seam.

import type { ActionRisk } from '../actions/approval'

export interface NativeToolSpec {
  /** Model-facing tool name. */
  name: string
  /** Model-facing description (kept plain, no marketing voice — this is a prompt). */
  description: string
  /** JSON schema for the tool's arguments. */
  parameters: Record<string, unknown>
  /** The native helper command this tool invokes. */
  command: string
  /** How consequential the action is — decides whether it gates for approval. */
  risk: ActionRisk
  /** Map the model's tool arguments to the helper command's args. */
  buildArgs: (toolArgs: Record<string, unknown>) => Record<string, unknown>
  /** One-line, user-facing approval-card title for a gated action. */
  title: (toolArgs: Record<string, unknown>) => string
  /** Turn a successful helper result into a string for the model. */
  formatResult: (result: unknown) => string
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

export const NATIVE_TOOL_SPECS: NativeToolSpec[] = [
  {
    name: 'calendar_create_event',
    description:
      "Create an event in the user's macOS Calendar. Times are ISO 8601 (e.g. 2026-08-13T15:00:00). Needs the user to approve before it is written.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        start: { type: 'string', description: 'Start time, ISO 8601' },
        end: {
          type: 'string',
          description: 'End time, ISO 8601. Defaults to one hour after start.'
        },
        notes: { type: 'string', description: 'Optional notes for the event' },
        allDay: { type: 'boolean', description: 'Whether the event lasts all day' },
        calendar: { type: 'string', description: 'Calendar name; defaults to the default calendar' }
      },
      required: ['title', 'start']
    },
    command: 'calendar.createEvent',
    risk: 'mutate',
    buildArgs: (a) => a,
    title: (a) => `Create the calendar event "${asString(a.title, 'Untitled')}"`,
    formatResult: (result) => {
      const id =
        typeof result === 'object' && result !== null
          ? asString((result as Record<string, unknown>).id)
          : ''
      return id ? `Created the calendar event (id ${id}).` : 'Created the calendar event.'
    }
  },
  {
    name: 'calendar_list_events',
    description:
      "List the user's macOS Calendar events between two ISO 8601 times. Read-only; runs without approval.",
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'string', description: 'Range start, ISO 8601' },
        end: { type: 'string', description: 'Range end, ISO 8601' }
      },
      required: ['start', 'end']
    },
    command: 'calendar.listEvents',
    risk: 'read',
    buildArgs: (a) => a,
    title: (a) => `List calendar events from ${asString(a.start)} to ${asString(a.end)}`,
    formatResult: (result) => JSON.stringify(result)
  }
]

const specsByName = new Map(NATIVE_TOOL_SPECS.map((s) => [s.name, s]))

export function findNativeToolSpec(name: string): NativeToolSpec | undefined {
  return specsByName.get(name)
}

export interface NativeToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export function buildNativeToolSchemas(): NativeToolSchema[] {
  return NATIVE_TOOL_SPECS.map((s) => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.parameters }
  }))
}
