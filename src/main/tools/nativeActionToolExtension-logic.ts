// Pure logic for the native-action tool extension: the table of semantic tools the
// model can call (calendar today; reminders / contacts / photos add as rows), plus
// schema building, risk classification, argument mapping, and result formatting. No
// Electron or process I/O here, so it is unit testable; the extension shell wires it
// to runNativeAction + the approval seam.

import { LEGACY_WEB_TASK_ACTION_TYPE, WEB_USE_ACTION_TYPE } from '@offgrid/use'
import type { ActionRisk } from '../actions/approval'

export const WEB_USE_TOOL_NAME = WEB_USE_ACTION_TYPE

export function canonicalNativeToolName(name: string): string {
  return name === LEGACY_WEB_TASK_ACTION_TYPE ? WEB_USE_TOOL_NAME : name
}

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
  /** Whether the tool is a long-running agentic task (engine-only, authoritative
   *  replies) or an ordinary inline action. Defaults to 'inline' when omitted, so
   *  only the task rows declare it. */
  kind?: 'task' | 'inline'
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
      "Create an event in the user's macOS Calendar. Times are ISO 8601 (e.g. 2026-08-13T15:00:00). A Chat request runs directly.",
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
      "Create a reminder in the user's macOS Reminders. Optional due time is ISO 8601. A Chat request runs directly.",
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
      "Send an iMessage from the user's Mac. 'to' is a phone number or email handle - use contacts_search first if you only have a name. A Chat request runs directly.",
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
    description: "Send an email from the user's Mac Mail. A Chat request runs directly.",
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
      "Open a URL or app scheme in the user's default browser or app (a web page, a mailto: draft, whatsapp://send). It ONLY opens - no searching, clicking, playing, logging in, or submitting. If the goal needs anything DONE on a website (play or watch a video, search and click a result, log in, place an order, fill a form), use web_use instead - it does the task inside Off Grid AI's own built-in browser.",
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
    name: WEB_USE_TOOL_NAME,
    description:
      "Do a task on a website in Off Grid AI's own built-in browser - playing or watching a video (YouTube, etc.), searching a site and opening a result, checking in for a flight, placing an order, filling a form, or logging in. Use this whenever the goal needs to click, type, or navigate a page, not merely open it - 'play X on YouTube' or 'search Y and open the first result' is web_use, not open_url. It runs INSIDE Off Grid AI's browser and never touches the user's cursor, keyboard, or their own browser, so the user keeps working while it goes; it hands control back for any sign-in, one-time code, or payment. Use the full conversation. Ask the user before calling this tool only when a material fact is missing. When you call it, describe the whole goal in one call, including all known key inputs, constraints, and the point where the task must stop.",
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description:
            'The complete task brief, including key inputs, constraints, and the point where Web Use must stop'
        },
        url: {
          type: 'string',
          description:
            'The site URL to start on (https://...), e.g. https://youtube.com. Always provide the site the task acts on.'
        }
      },
      required: ['goal']
    },
    // The engine routes this to the browser rail; command is unused on that
    // path (kept for the shape's sake, never sent to the native helper).
    command: 'web.task',
    risk: 'mutate',
    kind: 'task',
    buildArgs: (a) => ({
      goal: asString(a.goal),
      ...(typeof a.url === 'string' ? { url: a.url } : {})
    }),
    title: (a) => asString(a.goal, 'Run a web task'),
    formatResult: (result) => (typeof result === 'string' && result ? result : 'Done.')
  },
  {
    name: 'computer_task',
    description:
      'Complete a task by controlling a desktop APP directly - clicking, typing, and navigating its window - for things no other tool can do (a desktop app with no web version, sharing a file through an app UI). The user watches in a supervised overlay and can stop or take over at any time; sign-ins and payments are handed back to them. Prefer web_use for anything on a website and the direct tools (calendar/reminders/mail) whenever they fit - use this only when the task genuinely needs GUI control of an installed app.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'The task to complete, in one sentence (e.g. "share the deck in WhatsApp")'
        }
      },
      required: ['goal']
    },
    // The engine routes this to the vision rail; command is unused on that path.
    command: 'computer.task',
    risk: 'mutate',
    kind: 'task',
    buildArgs: (a) => ({ goal: asString(a.goal) }),
    title: (a) => asString(a.goal, 'Run a computer-use task'),
    formatResult: (result) => (typeof result === 'string' && result ? result : 'Done.')
  }
]

const specsByName = new Map(NATIVE_TOOL_SPECS.map((s) => [s.name, s]))

export function findNativeToolSpec(name: string): NativeToolSpec | undefined {
  return specsByName.get(canonicalNativeToolName(name))
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
  [WEB_USE_TOOL_NAME]: WEB_USE_ACTION_TYPE,
  computer_task: 'computer_task'
} as const

export function actionTypeForTool(
  name: string
): (typeof TOOL_ACTION_TYPES)[keyof typeof TOOL_ACTION_TYPES] | undefined {
  return (
    TOOL_ACTION_TYPES as Record<string, (typeof TOOL_ACTION_TYPES)[keyof typeof TOOL_ACTION_TYPES]>
  )[canonicalNativeToolName(name)]
}

/** Tool names and engine action types of the long-running task tools, read from
 *  the spec table's `kind` trait (a task tool's action type equals its name). */
const TASK_ACTION_TYPES: ReadonlySet<string> = new Set(
  NATIVE_TOOL_SPECS.filter((spec) => spec.kind === 'task').flatMap((spec) => {
    const actionType = actionTypeForTool(spec.name)
    return actionType ? [spec.name, actionType] : [spec.name]
  })
)

/** Whether a tool name or engine action type belongs to a long-running task tool.
 *  Driven by the spec table: a new task tool needs one `kind: 'task'` spec entry,
 *  no caller edits. */
export function isTaskAction(nameOrActionType: string): boolean {
  return TASK_ACTION_TYPES.has(nameOrActionType)
}

/** Canonical portable task kind for an engine action type. */
export function taskKindForActionType(actionType: string): 'web_use' | 'computer_use' | undefined {
  const canonical = canonicalNativeToolName(actionType)
  if (canonical === WEB_USE_TOOL_NAME) return 'web_use'
  return canonical === 'computer_task' ? 'computer_use' : undefined
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
  // The browser + vision rails are cross-platform (Electron CDP / the nut.js
  // native addon are the same everywhere).
  WEB_USE_TOOL_NAME,
  'computer_task'
])

export const PRO_USE_TOOL_NAMES: ReadonlySet<string> = new Set([WEB_USE_TOOL_NAME, 'computer_task'])

export function specsForPlatform(
  platform: NodeJS.Platform,
  includeProUse = true
): NativeToolSpec[] {
  let specs: NativeToolSpec[]
  if (platform === 'darwin') {
    specs = NATIVE_TOOL_SPECS
  } else if (platform === 'win32') {
    specs = NATIVE_TOOL_SPECS.filter((spec) => WINDOWS_TOOL_NAMES.has(spec.name))
  } else {
    specs = []
  }
  return includeProUse ? specs : specs.filter((spec) => !PRO_USE_TOOL_NAMES.has(spec.name))
}

/** The model-facing capability hint, per platform - never promise a tool the
 *  platform does not expose. */
export function systemHintForPlatform(platform: NodeJS.Platform, includeProUse = true): string {
  if (platform === 'darwin') {
    if (!includeProUse) {
      return "You can act on the user's Mac: manage calendar events (calendar_create_event, calendar_list_events) and reminders (reminders_create, reminders_list), look up people (contacts_search), and send an iMessage (messages_send) or email (mail_send). Resolve a name to a handle with contacts_search before sending. Open a link or app scheme with open_url; it opens the target without interacting with it. Use ISO 8601 for all times. Actions requested in this Chat run directly; report the real result and never tell the user to approve them."
    }
    return "You can act on the user's Mac: manage calendar events (calendar_create_event, calendar_list_events) and reminders (reminders_create, reminders_list), look up people (contacts_search), and send an iMessage (messages_send) or email (mail_send). Resolve a name to a handle with contacts_search before sending. Open a link or app scheme (like whatsapp://send) with open_url - it ONLY opens, no interaction. To actually DO something on a website - play or watch a video, search and click a result, check in, order, fill a form, log in - use web_use (NOT open_url); it runs the task inside Off Grid AI's own built-in browser without touching the user's cursor or their own browser, so they keep working, and hands back for any sign-in or payment. For a task that needs to control a desktop app with no web version, use computer_task - the user watches and can take over. Prefer the direct tools and web_use when they fit. Use ISO 8601 for all times. Actions and tasks requested in this Chat run directly; report the real result and never tell the user to approve them."
  }
  if (platform === 'win32') {
    if (!includeProUse) {
      return "You can act on the user's PC through Outlook: create calendar events (calendar_create_event) and tasks (reminders_create), and send an email (mail_send). Open a link or app with open_url; it opens the target without interacting with it. Use ISO 8601 for all times. There is no message or contact lookup tool on Windows. Actions requested in this Chat run directly; report the real result and never tell the user to approve them."
    }
    return "You can act on the user's PC through Outlook: create calendar events (calendar_create_event) and tasks (reminders_create), and send an email (mail_send). Open a link or app with open_url - it ONLY opens, no interaction. To DO something on a website - play or watch a video, search and click a result, check in, order, fill a form, log in - use web_use (NOT open_url); it runs the task inside Off Grid AI's own built-in browser without touching the user's cursor or their own browser, so they keep working, and hands back for any sign-in or payment. For a task that needs to control a desktop app with no web version, use computer_task - the user watches and can take over. Prefer the direct tools and web_use when they fit. Use ISO 8601 for all times. There is no message or contact lookup tool on Windows. Actions and tasks requested in this Chat run directly; report the real result and never tell the user to approve them."
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
