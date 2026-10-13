// The bridge's injected dependencies and data shapes. Types only, so the RPC handlers and the
// service can both use them without importing each other.

import type { BridgeMediaData } from './bridge-media-handlers'
import type {
  ConversationListParams,
  ConversationSearchParams,
  ConversationSearchResult,
  ConversationPage
} from './bridge-conversations'
import type { ChatRequest } from './bridge-chat'
import type { BridgeFeatures } from './bridge-protocol'
import type { SettingsSection } from './bridge-settings'

export interface PairedBrowser {
  readonly id: string
  readonly name: string
  readonly publicKey: string
  readonly pairedAt: number
}

export interface BridgeStore {
  list(): Promise<readonly PairedBrowser[]>
  save(browsers: readonly PairedBrowser[]): Promise<void>
}

/** What a paired browser sees of a web task it started (desktop task-progress.ts). */
export interface BrowserTaskProgress {
  readonly taskId: string
  readonly status: string
  readonly summary: string
  /** Phase titles in order; empty before the plan is made. */
  readonly plan: readonly string[]
  /** Index into `plan` of the phase in progress, or -1 with no plan. */
  readonly phase: number
  readonly steps: readonly string[]
  readonly action: string
}

export interface BridgeData extends Partial<BridgeMediaData> {
  chat?(request: ChatRequest, browser: PairedBrowser): Promise<unknown>
  features(): BridgeFeatures
  desktopName(): string
  listConversations(): Promise<unknown[]>
  listConversationPage?(params: ConversationListParams): Promise<ConversationPage<unknown>>
  searchConversations?(params: ConversationSearchParams): Promise<ConversationSearchResult>
  putConversation(conversation: unknown, browser: PairedBrowser): Promise<void>
  deleteConversation(id: string): Promise<void>
  listTools(task?: string): Promise<unknown[]>
  /** `tabId`: the browser's tab a web task should start in (browser-start-tab.ts). */
  runTool(
    name: string,
    args: Record<string, unknown>,
    browser: PairedBrowser,
    tabId?: number
  ): Promise<unknown>
  /** Task progress scoped to the browser and optional task id. */
  latestTask(
    browser: PairedBrowser,
    since: number,
    taskId?: string
  ): Promise<BrowserTaskProgress | null>
  /** Stops a task this browser started (its journey is this browser's). False otherwise. */
  stopTask(browser: PairedBrowser, taskId: string): Promise<boolean>
  setTaskRole(request: {
    task: unknown
    role: unknown
    modelId: unknown
  }): Promise<{ success: boolean; error?: string }>
  vault(request: unknown, browser: PairedBrowser): Promise<unknown>
  /** One section of the desktop's settings (settings.ts), as its Settings screen shows it. */
  readSettings(section: SettingsSection): Promise<unknown>
  /** Apply an already-validated patch through the desktop's own setters. */
  writeSettings(section: SettingsSection, patch: Record<string, unknown>): Promise<void>
}

export interface BridgeDeps {
  readonly keys: CryptoKeyPair
  readonly store: BridgeStore
  /** Show the code and the browser's name in the desktop's own window. True = approved. */
  confirmPairing(code: string, deviceName: string, peerAddress: string): Promise<boolean>
  readonly data: BridgeData
  now(): number
  newId(): string
}

export type BridgeReply = { status: number; body: unknown }
