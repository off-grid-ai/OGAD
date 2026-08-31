// Function-hook seam (main process). Pro features register plain functions
// against named hooks during activation; core calls them when present and falls
// back to a default/no-op when absent. Use for BEHAVIOUR the core must defer to
// pro for — e.g. augmenting the chat prompt with captured context, contributing
// extra universal-search sources, or adding tray menu items.
//
// Free builds register nothing, so callHook returns undefined and core keeps its
// own default behaviour. Mirrors mobile/src/bootstrap/hookRegistry.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HookFn = (...args: any[]) => any

const hooks: Record<string, HookFn> = {}

export function registerHook(name: string, fn: HookFn): void {
  hooks[name] = fn
}

/** Remove a registered hook. No-op when absent. Mainly for test isolation and
 *  for retiring a legacy hook name once its replacement is registered. */
export function unregisterHook(name: string, expected?: HookFn): void {
  if (!expected || hooks[name] === expected) delete hooks[name]
}

/** Whether a hook is currently registered. Lets a caller distinguish "no handler"
 *  from "handler ran and returned undefined" — needed when falling back from a new
 *  hook name to a legacy one. */
export function hasHook(name: string): boolean {
  return name in hooks
}

/** Call a hook if registered; returns its result, or undefined when absent. */
export function callHook<R = unknown>(name: string, ...args: unknown[]): R | undefined {
  const fn = hooks[name]
  return fn ? (fn(...args) as R) : undefined
}

/** Await a hook if registered; returns its resolved result, or undefined. */
export async function callHookAsync<R = unknown>(
  name: string,
  ...args: unknown[]
): Promise<R | undefined> {
  const fn = hooks[name]
  if (!fn) return undefined
  return (await fn(...args)) as R
}

/** Known hook names, centralised so core and pro stay in sync. */
export const HOOKS = {
  /** (basePrompt: string, query: string) => Promise<string> — augment the chat
   *  system/context with captured memory + entity/observation context (pro). */
  chatAugmentContext: 'chat.augmentContext',
  /** () => Promise<SearchSource[]> — extra universal-search sources (pro). */
  searchExtraSources: 'search.extraSources',
  /**
   * (connectorId: number, url: string | null) => ConnectorToolSource | undefined - lets Pro
   * providers own verification, read-tool discovery, and execution through their supported protocol.
   */
  mcpConnectorToolSource: 'mcp:connectorToolSource',
  /** (mutation: SyncMutation) => void - record a committed core data change in Pro sync. */
  syncRecordLocalMutation: 'sync.recordLocalMutation',
  /**
   * (mutation: KnowledgeDocumentMutation) => void - a committed RAG document lifecycle change.
   * Pro transfers/reconciles it; free builds leave the hook unregistered.
   */
  syncKnowledgeDocumentMutation: 'sync.knowledgeDocumentMutation',
  /**
   * (mutation: LocalSharedFileMutation) => void - committed generated media or attachment bytes.
   * Pro owns transfer and consent; free builds leave this inert.
   */
  syncSharedFileMutation: 'sync.sharedFileMutation',
  /**
   * (snapshot: { conversationId, content, reasoning } | null) => void - the reply this device is
   * generating, or null when it is generating nothing. Pro streams it live to paired devices; free
   * builds leave it inert. A SNAPSHOT rather than a delta, so a consumer cannot miss the end.
   */
  syncStreamingState: 'sync.streamingState',
  /** (request: ActionApprovalRequest) => boolean — offer a consequential action
   *  for approval; returns true when queued (caller must not execute). Pro
   *  registers it to route the action through its approval queue + audit log. */
  actionsProposeApproval: 'actions:proposeApproval',
  /** ({ conversationId, message }) => Promise<{ answer: string } | null> - lets Pro resolve a
   * confirmation written in an Action's execution chat before the model can infer a new Action. */
  actionsResolveChatDecision: 'actions:resolveChatDecision',
  /** (task: TaskRunSnapshot) => void - lets Pro project the normal task outcome onto the
   * approval that started the task. Core task state remains the single source of truth. */
  actionsObserveTaskResult: 'actions:observeTaskResult',
  /** Legacy MCP-only predecessor of actionsProposeApproval. Kept so a pro build
   *  that has not yet migrated still gates connector writes; remove once
   *  desktop-pro registers actionsProposeApproval. */
  legacyMcpProposeApproval: 'mcp:proposeApproval'
} as const
