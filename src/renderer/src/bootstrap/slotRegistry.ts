import type { ComponentType } from 'react'

// Component-slot seam. Pro registers UI components into named slots inside core
// screens during activation; core renders whatever is registered and renders its
// own fallback (or nothing) when a slot is empty. Lets pro inject UI into core
// screens without core importing pro. Mirrors mobile/src/bootstrap/slotRegistry.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const slots: Record<string, ComponentType<any>> = {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerSlot(name: string, component: ComponentType<any>): void {
  slots[name] = component
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getSlot(name: string): ComponentType<any> | undefined {
  return slots[name]
}

export function clearRegisteredSlots(): void {
  for (const name of Object.keys(slots)) delete slots[name]
}

/** Known slot names, centralised so core and pro stay in sync. */
export const SLOTS = {
  /** Extra row(s) in the chat composer tool menu (e.g. the Connectors toggle). */
  composerToolMenu: 'composer.toolMenu',
  /** Always-mounted root component(s) near the app root (e.g. capture indicator). */
  appRoot: 'app.root',
  /** Per-connector credential setup UI for `oauthClient: 'byo'` entries (e.g. the
   *  Google client_id/secret form). Receives the catalog entry as a prop. */
  connectorSetup: 'connectors.setup',
  /** Rows appended after the message list of the open conversation (e.g. a reply
   *  streaming live on another device). Receives `{ conversationId }`. */
  chatMessagesFooter: 'chat.messagesFooter',
  /** Licensed Browser Use and Computer Use task workspace. */
  taskWorkspace: 'tasks.workspace',
  /** Licensed Web Use and Computer Use settings inside the shared Settings drawer. */
  taskSettings: 'tasks.settings',
  /** Optional task supervisor surface mounted above the chat composer. */
  taskSupervisorOverlay: 'tasks.supervisorOverlay',
  /** A running task, kept visible in a floating card after its workspace is left. Mounted at the
   *  app root, OUTSIDE the route switch: the whole point is to survive navigation, so anything
   *  route-scoped unmounts it exactly when it is needed. */
  taskFloatingView: 'tasks.floatingView'
} as const
