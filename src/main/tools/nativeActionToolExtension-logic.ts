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
  },
  {
    name: 'open_url',
    description:
      "Open a URL or app link on the user's Mac - a web page, a mailto: draft, or an app scheme like whatsapp://send. Opens only; it does not submit or send anything.",
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL or app-scheme link to open' }
      },
      required: ['url']
    },
    command: 'system.openURL',
    risk: 'navigate',
    buildArgs: (a) => a,
    title: (a) => `Open ${asString(a.url)}`,
    formatResult: () => 'Opened it.'
  },
  {
    name: 'web_task',
    description:
      'Complete a task on a website in a watched browser pane the user can see - checking in for a flight, placing an order, filling a form. Describe the whole goal in one call; the assistant drives the page step by step and hands control back to the user for any sign-in, one-time code, or payment. Never use this for reading a page - only for tasks that click, fill, or submit.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description:
            'The task to complete, in one sentence (e.g. "check in for my flight tomorrow")'
        },
        url: { type: 'string', description: 'Optional starting URL (https://...)' }
      },
      required: ['goal']
    },
    // The engine routes this to the browser rail; command is unused on that
    // path (kept for the shape's sake, never sent to the native helper).
    command: 'web.task',
    risk: 'mutate',
    buildArgs: (a) => ({
      goal: asString(a.goal),
      ...(typeof a.url === 'string' ? { url: a.url } : {})
    }),
    title: (a) => asString(a.goal, 'Run a web task'),
    formatResult: (result) => (typeof result === 'string' && result ? result : 'Done.')
  }
]

const specsByName = new Map(NATIVE_TOOL_SPECS.map((s) => [s.name, s]))

export function findNativeToolSpec(name: string): NativeToolSpec | undefined {
  return specsByName.get(name)
}

/**
 * Which durable Action type a gated tool becomes when it routes through the
 * @offgrid/use engine. Only the mutating tools appear here - reads and
 * navigation run inline (architecture decision 5). Defined once; the
 * extension and its tests both read this map.
 */
export const TOOL_ACTION_TYPES = {
  calendar_create_event: 'calendar',
  reminders_create: 'reminder',
  messages_send: 'message',
  mail_send: 'email',
  web_task: 'web_task'
} as const

export function actionTypeForTool(
  name: string
): (typeof TOOL_ACTION_TYPES)[keyof typeof TOOL_ACTION_TYPES] | undefined {
  return (
    TOOL_ACTION_TYPES as Record<string, (typeof TOOL_ACTION_TYPES)[keyof typeof TOOL_ACTION_TYPES]>
  )[name]
}

/**
 * Which tools each platform exposes to the model. macOS ships the full set
 * (the Swift helper). Windows ships the engine-routed set the local Outlook
 * rail supports; reads stay macOS-only until the Outlook read verbs land.
 * Defined once - the extension, its registration, and the tests all read
 * this. An unlisted platform exposes nothing.
 */
export const WINDOWS_TOOL_NAMES: ReadonlySet<string> = new Set([
  'calendar_create_event',
  'reminders_create',
  'mail_send',
  'open_url',
  // The browser rail is cross-platform (Electron CDP is the same everywhere).
  'web_task'
])

export function specsForPlatform(platform: NodeJS.Platform): NativeToolSpec[] {
  if (platform === 'darwin') {
    return NATIVE_TOOL_SPECS
  }
  if (platform === 'win32') {
    return NATIVE_TOOL_SPECS.filter((spec) => WINDOWS_TOOL_NAMES.has(spec.name))
  }
  return []
}

/** The model-facing capability hint, per platform - never promise a tool the
 *  platform does not expose. */
export function systemHintForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return "You can act on the user's Mac: manage calendar events (calendar_create_event, calendar_list_events) and reminders (reminders_create, reminders_list), look up people (contacts_search), and send an iMessage (messages_send) or email (mail_send). Resolve a name to a handle with contacts_search before sending. Open a link or app scheme (like whatsapp://send) with open_url. Complete a task on a website - a check-in, an order, a form - with web_task, describing the whole goal in one call; it runs in a watched pane and hands back to the user for any sign-in or payment. Use ISO 8601 for all times. Anything that creates, sends, or runs a web task needs the user's approval; tell them it is pending until they approve."
  }
  if (platform === 'win32') {
    return "You can act on the user's PC through Outlook: create calendar events (calendar_create_event) and tasks (reminders_create), and send an email (mail_send). Open a link or app with open_url. Complete a task on a website - a check-in, an order, a form - with web_task, describing the whole goal in one call; it runs in a watched pane and hands back to the user for any sign-in or payment. Use ISO 8601 for all times. There is no message or contact lookup tool on Windows. Anything that creates, sends, or runs a web task needs the user's approval; tell them it is pending until they approve."
  }
  return ''
}

export interface NativeToolSchema {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export function buildNativeToolSchemas(
  specs: NativeToolSpec[] = NATIVE_TOOL_SPECS
): NativeToolSchema[] {
  return specs.map((s) => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.parameters }
  }))
}
