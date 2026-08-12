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

/** Shared "Created the <label> (id …)" formatter for the create tools, so each new
 *  create row reuses one confirmation shape instead of re-encoding it. */
function formatCreated(label: string): (result: unknown) => string {
  return (result) => {
    const id =
      typeof result === 'object' && result !== null
        ? asString((result as Record<string, unknown>).id)
        : ''
    return id ? `Created the ${label} (id ${id}).` : `Created the ${label}.`
  }
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
    formatResult: formatCreated('calendar event')
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
  },
  {
    name: 'reminders_create',
    description:
      "Create a reminder in the user's macOS Reminders. Optional due time is ISO 8601. Needs the user to approve before it is written.",
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Reminder title' },
        notes: { type: 'string', description: 'Optional notes for the reminder' },
        due: { type: 'string', description: 'Optional due time, ISO 8601' }
      },
      required: ['title']
    },
    command: 'reminders.create',
    risk: 'mutate',
    buildArgs: (a) => a,
    title: (a) => `Create the reminder "${asString(a.title, 'Untitled')}"`,
    formatResult: formatCreated('reminder')
  },
  {
    name: 'reminders_list',
    description: "List the user's incomplete macOS reminders. Read-only; runs without approval.",
    parameters: { type: 'object', properties: {} },
    command: 'reminders.list',
    risk: 'read',
    buildArgs: (a) => a,
    title: () => 'List incomplete reminders',
    formatResult: (result) => JSON.stringify(result)
  },
  {
    name: 'contacts_search',
    description:
      "Search the user's macOS Contacts by name. Returns matching names with their phone numbers and emails. Read-only; runs without approval.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name to search for' }
      },
      required: ['query']
    },
    command: 'contacts.search',
    risk: 'read',
    buildArgs: (a) => a,
    title: (a) => `Search contacts for "${asString(a.query)}"`,
    formatResult: (result) => JSON.stringify(result)
  },
  {
    name: 'messages_send',
    description:
      "Send an iMessage from the user's Mac. 'to' is a phone number or email handle - use contacts_search first if you only have a name. Needs the user to approve before it is sent.",
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Phone number or email handle' },
        text: { type: 'string', description: 'Message text' }
      },
      required: ['to', 'text']
    },
    command: 'messages.send',
    risk: 'mutate',
    buildArgs: (a) => a,
    title: (a) => `Send a message to ${asString(a.to)}`,
    formatResult: () => 'Sent the message.'
  },
  {
    name: 'mail_send',
    description:
      "Send an email from the user's Mac Mail. Needs the user to approve before it is sent.",
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address' },
        subject: { type: 'string', description: 'Email subject' },
        body: { type: 'string', description: 'Email body' }
      },
      required: ['to']
    },
    command: 'mail.send',
    risk: 'mutate',
    buildArgs: (a) => a,
    title: (a) => `Email ${asString(a.to)}`,
    formatResult: () => 'Sent the email.'
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
