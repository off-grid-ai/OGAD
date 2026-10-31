/**
 * Every top-level screen the app routes to. App's ViewMode is this list, so a new screen is added
 * here first, and the page-shell guard test mounts each one: a screen that skips PageShell fails it.
 */
export const VIEW_MODES = [
  'dashboard',
  'explore',
  'day',
  'replay',
  'reflect',
  'actions',
  'connectors',
  'meetings',
  'chats',
  'entities',
  'memory-chat',
  'tasks',
  'models',
  'gateway',
  'projects',
  'notifications',
  'settings',
  'search',
  'clipboard',
  'voice',
  'vault',
  'devices',
  'video'
] as const

export type ViewMode = (typeof VIEW_MODES)[number]
