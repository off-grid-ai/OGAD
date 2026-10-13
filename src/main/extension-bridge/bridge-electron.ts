import { remoteVisionModelId } from '../../shared/remote-vision-server'
import { activeTextAvailability, remoteTextVision } from '../../shared/model-settings-rules'
import type { TextSettings } from './bridge-settings'
import { plainConversationPage, plainConversationSearchPage } from './bridge-conversation-pages'
import type {
  ConversationPage,
  ConversationSearchResult,
  ConversationListParams,
  ConversationSearchParams
} from './bridge-conversations'
// The real dependencies for the extension bridge: key storage (encrypted at rest by the OS),
// the native confirm dialog, OGAD's chat tables, the live tool registry, and Pro gating.
//
// What a browser can reach follows what THIS desktop actually has: chats and MCP connectors are
// core; the native action tools and the vault exist only when Pro is active, because only then
// are they registered. Nothing here grants a browser more than the desktop app itself has.

import { getTaskRun, listTaskRuns } from '../tasks/task-history'
import { controlVisionTask, stopVisionTaskBeforeStart } from '../vision/vision-controller'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { app, BrowserWindow, dialog, safeStorage } from 'electron'
import {
  addRagMessage,
  createRagConversation,
  deleteRagConversation,
  getDB,
  getRagConversation,
  updateRagConversationTitle,
  getRagConversations,
  getRagMessages,
  getSettings,
  saveSetting
} from '../database'
import { enabledToolSchemas, getToolExtensions, runTool } from '../tools'
import { llm } from '../llm'
import { selectRelevantTools } from '../tools/tool-ranking'
import {
  contextualToolRoutingText,
  selectRelevantToolsSemantic
} from '../tools/tool-embedding-ranking'
import { budgetTools, MAX_TOOL_TOKENS } from '../tools/tool-budget'
import { embeddings } from '../embeddings'
import { isToolAllowedForOrigin } from '../tools/tool-origin'
import { notifyRagConversationChanged } from '../rag-conversation-events'
import { callHook, callHookAsync, hasHook, HOOKS } from '../bootstrap/hookRegistry'
import { getSecret } from '../secrets'
import { proEnabled } from '../bootstrap/loadProFeaturesMain'
import { getWebUseSettings, setWebUseSettings } from '../web-use-settings'
import { getComputerUseSettings, setComputerUseSettings } from '../computer-use-settings'
import { listTools as listDesktopTools, setToolEnabled } from '../tools'
import { addConnector, listConnectors, removeConnector, setConnectorEnabled } from '../mcp'
import { imageGenStatus } from '../imagegen'
import { readTranscriptionInfo } from '../transcription/select'
import { resolveImageParameters, setImageParameterOverride } from '@offgrid/models'
import { createSettingsStore } from './bridge-settings-store'
import {
  activateRemoteVisionModel,
  deactivateRemoteVisionModel,
  getRemoteVisionServerSettings,
  getActiveRemoteVisionServer
} from '../vision/remote-vision-server'
import { remoteModelSelected } from '../active-models'
import {
  getActiveModel,
  getVisionStatuses,
  getActiveModelIds,
  getActiveModalities,
  getCatalog,
  listInstalled,
  setActiveModalChoice
} from '../models-manager'
import {
  createBridgeService,
  type BridgeData,
  type BridgeFeatures,
  type BridgeService,
  type BridgeStore,
  type PairedBrowser
} from './bridge-service'
import {
  BROWSER_ORIGIN_PREFIX,
  setBrowserConversationOrigin,
  MAX_LISTED,
  parseBridgeConversation,
  toBridgeConversation,
  turnsToAppend,
  historyConflicts,
  newerBrowserTitle,
  HISTORY_CONFLICT
} from './bridge-conversations'
import { generateKeyPair } from './bridge-protocol'
import {
  browserTaskById,
  createAcceptedTasks,
  latestBrowserTask,
  stopRoute
} from './bridge-task-progress'
import { createLinkRegistry, type BrowserLink } from './bridge-socket'

const storePath = (): string => path.join(app.getPath('userData'), 'extension-bridge.json')

interface StoreFile {
  version: 1
  /** The desktop's private key as JWK, encrypted by safeStorage when the OS offers it. */
  key: { enc: 'safeStorage' | 'none'; data: string }
  browsers: PairedBrowser[]
}

function readFile(): StoreFile | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Partial<
      Record<keyof StoreFile, unknown>
    >
    return parsed.version === 1 && Array.isArray(parsed.browsers) ? (parsed as StoreFile) : null
  } catch {
    return null
  }
}

function writeFile(file: StoreFile): void {
  fs.writeFileSync(storePath(), JSON.stringify(file), { mode: 0o600 })
}

async function loadOrCreateKeys(): Promise<{ keys: CryptoKeyPair; file: StoreFile }> {
  const existing = readFile()
  if (existing) {
    const json =
      existing.key.enc === 'safeStorage'
        ? safeStorage.decryptString(Buffer.from(existing.key.data, 'base64'))
        : existing.key.data
    const jwk = JSON.parse(json) as JsonWebKey
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits']
    )
    const { d: _d, key_ops: _ops, ...pub } = jwk
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      pub,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    )
    return { keys: { privateKey, publicKey }, file: existing }
  }
  const keys = await generateKeyPair(true)
  const jwk = JSON.stringify(await crypto.subtle.exportKey('jwk', keys.privateKey))
  const encrypted = safeStorage.isEncryptionAvailable()
  const file: StoreFile = {
    version: 1,
    key: encrypted
      ? { enc: 'safeStorage', data: safeStorage.encryptString(jwk).toString('base64') }
      : { enc: 'none', data: jwk },
    browsers: []
  }
  writeFile(file)
  return { keys, file }
}

function store(): BridgeStore {
  return {
    list: async () => readFile()?.browsers ?? [],
    save: async (browsers) => {
      const file = readFile()
      if (file) {
        writeFile({ ...file, browsers: [...browsers] })
        const paired = new Set(browsers.map((browser) => browser.id))
        for (const link of links.list()) {
          if (!paired.has(link.browser.id)) link.close()
        }
      }
    }
  }
}

const PAIR_TIMEOUT_MS = 120_000

export async function confirmPairing(
  code: string,
  deviceName: string,
  peerAddress: string
): Promise<boolean> {
  const win = BrowserWindow.getAllWindows()[0]
  win?.show()
  win?.focus()
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peerAddress)
  const controller = new AbortController()
  const options = {
    signal: controller.signal,
    type: 'question' as const,
    buttons: ['Pair', "Don't pair"],
    defaultId: 1,
    cancelId: 1,
    title: 'Pair a browser',
    message: `Pair "${deviceName}" with Off Grid AI Desktop?`,
    detail:
      `Only continue if your browser shows these same words:\n\n${code}\n\n` +
      `The browser can then use your chats, tools and (with Pro) vault through an encrypted, ${
        local
          ? 'private link on this computer. '
          : `private link. This request comes from another device on the network (${peerAddress}). `
      }It does not count as one of your devices.`
  }
  const shown = win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  const timeout = setTimeout(() => controller.abort(), PAIR_TIMEOUT_MS)
  try {
    return (await shown).response === 0 && !controller.signal.aborted
  } finally {
    clearTimeout(timeout)
  }
}

/** Paired browsers and whether each is connected over the live socket now (Tasks > Web Use). */
export function listBridgeBrowsers(): Array<{ name: string; connected: boolean }> {
  const live = new Set(links.list().map((l) => l.browser.id))
  return (readFile()?.browsers ?? []).map((b) => ({ name: b.name, connected: live.has(b.id) }))
}

function features(): BridgeFeatures {
  // The same Pro decision the rest of the app uses (license, or the dev OFFGRID_PRO switch).
  const pro = proEnabled()
  const exts = getToolExtensions()
  return {
    pro,
    chats: pro,
    browserChat: hasHook(HOOKS.extensionChatRequest) ? 2 : 0,
    tools: pro && exts.some((e) => e.category === 'tool'),
    connectors: pro && exts.some((e) => e.category !== 'tool'),
    vault: pro && hasHook(HOOKS.extensionVaultRequest),
    // Keep the live socket open only while tasks are set to use the default browser.
    browserTasks: pro && getWebUseSettings().browserTarget === 'default_browser'
  }
}

export async function listBridgeTools(task?: string): Promise<unknown[]> {
  const out: unknown[] = []
  // Direct browser calls can use only read-only tools, including those declared by extensions.
  const catalog = (await enabledToolSchemas(getToolExtensions())).filter(({ schema, extension }) =>
    isToolAllowedForOrigin((schema as { function?: { name?: unknown } }).function?.name, 'bridge', {
      acting: false,
      extension
    })
  )
  for (const { schema, extension } of catalog) {
    const fn = (
      schema as { function?: { name?: unknown; description?: unknown; parameters?: unknown } }
    ).function
    if (typeof fn?.name === 'string') {
      const source = !extension || extension.category === 'tool' ? 'native' : 'connector'
      out.push({
        name: fn.name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters: fn.parameters ?? { type: 'object', properties: {} },
        source,
        ...(source === 'connector' && extension ? { connector: extension.id } : {})
      })
    }
  }
  if (task === undefined) return out
  const schemas = out.map((tool) => {
    const item = tool as { name: string; description: string; parameters: unknown }
    return {
      type: 'function',
      function: { name: item.name, description: item.description, parameters: item.parameters }
    }
  })
  const direct = selectRelevantTools(task, schemas)
  let semantic: unknown[] = []
  const named = schemas.some((schema) =>
    task.toLowerCase().includes(schema.function.name.toLowerCase())
  )
  if (task.trim() && !named && schemas.length) {
    try {
      semantic = await selectRelevantToolsSemantic(contextualToolRoutingText(task, []), schemas, {
        embed: (text) => embeddings.generateEmbedding(text)
      })
    } catch {
      // Keep Desktop's direct-match fallback when the local embedding model cannot load.
    }
  }
  const selected = [...direct, ...semantic.filter((tool) => !direct.includes(tool))]
  const cap = Math.max(
    1024,
    Math.min(Math.floor(llm.effectiveContextSize() * 0.4), MAX_TOOL_TOKENS)
  )
  const budgeted = budgetTools(selected, cap, 0)
  return budgeted.tools.map((tool) => {
    const fn = (tool as { function: { name: string; description: string; parameters: unknown } })
      .function
    const original = out.find((entry) => (entry as { name: string }).name === fn.name) as Record<
      string,
      unknown
    >
    return { ...original, description: fn.description, parameters: fn.parameters }
  })
}

// The same functions Settings here uses, so a browser and this window always agree.
const settingsStore = createSettingsStore({
  text: async () => {
    const remote = getActiveRemoteVisionServer()
    const local = remote ? null : llm.activeModelInfo()
    const active = remote
      ? {
          vision: remoteTextVision(remote.modelCatalog?.find((model) => model.id === remote.model))
        }
      : local
    const activeModelId = remote
      ? remoteVisionModelId(remote.id, remote.model)
      : (local?.id ?? null)
    return {
      ...llm.getSettings(),
      activeModelId,
      availability: activeTextAvailability(
        active,
        active ? await llm.toolPlannerPreflight() : null,
        getSettings().toolsEnabled !== false
      )
    }
  },
  setText: async (patch: TextSettings) => {
    await llm.setSettings(patch)
  },
  activeIds: getActiveModelIds,
  web: getWebUseSettings,
  setWeb: (next) => void setWebUseSettings(next),
  computer: getComputerUseSettings,
  setComputer: (next) => void setComputerUseSettings(next),
  remote: () => {
    const r = getRemoteVisionServerSettings()
    return {
      activeServerId: r.activeServerId,
      textOnRemote: remoteModelSelected('text'),
      servers: r.servers
    }
  },
  useRemote: (serverId) => {
    const server = getRemoteVisionServerSettings().servers.find((s) => s.id === serverId)
    return Boolean(server?.model) && activateRemoteVisionModel(serverId, server!.model)
  },
  remoteOff: deactivateRemoteVisionModel,
  taskModels: async () => {
    const [catalog, installed, companionStatus] = await Promise.all([
      getCatalog(),
      listInstalled(),
      getVisionStatuses()
    ])
    const active = (getActiveModalities() as Record<string, string | null>).computer_use
    return {
      catalog: catalog.models as Record<string, unknown>[],
      installed,
      activeGrounder: active ?? null,
      activeChatId: getActiveModel(),
      companionStatus
    }
  },
  setLocalGrounder: async (modelId) => {
    await setActiveModalChoice('computer_use', modelId)
  },
  appSettings: () => getSettings() as Record<string, unknown>,
  saveSetting,
  listTools: listDesktopTools,
  setToolEnabled,
  listConnectors,
  // Accounts are live-only connectors; Pro names what each can read.
  accountAccess: (id) =>
    getSecret(`connector:${id}:live-only`) === 'true'
      ? (callHook<{ services: string[]; missing: string[] }>(HOOKS.accountAccess, id) ?? {
          services: [],
          missing: []
        })
      : null,
  addConnector: (c) => void addConnector(c),
  setConnectorEnabled,
  removeConnector,
  activeImageModel: () => {
    const status = imageGenStatus()
    return status.active ?? status.models[0] ?? null
  },
  imageParams: (model, settings) =>
    resolveImageParameters({ id: model }, settings as Parameters<typeof resolveImageParameters>[1]),
  setImageParam: (settings, model, key, value) =>
    setImageParameterOverride(
      settings as Parameters<typeof setImageParameterOverride>[0],
      model,
      key,
      value
    ),
  transcription: readTranscriptionInfo
})

/** The journey every task a browser starts belongs to: its chats' origin. */
const journeyOf = (browser: PairedBrowser): string => `${BROWSER_ORIGIN_PREFIX}${browser.id}`

/** The task ids each browser was given (bridge-task-progress.ts). */
const acceptedTasks = createAcceptedTasks()

async function readConversationPage(
  params: ConversationListParams | ConversationSearchParams
): Promise<ConversationPage<unknown>> {
  if (!hasHook(HOOKS.extensionChatRequest)) return plainConversationPage(params)
  return (
    (await callHookAsync<ConversationPage<unknown>>(HOOKS.extensionChatRequest, {
      action: 'conversations',
      page: params
    })) ?? { conversations: [] }
  )
}

const data: BridgeData = {
  chat: async (request, browser) => {
    if (!hasHook(HOOKS.extensionChatRequest)) {
      if (request.action === 'disconnect') return true
      throw new Error('chat_unavailable')
    }
    return callHookAsync(HOOKS.extensionChatRequest, request, browser)
  },
  features,
  desktopName: () => 'Off Grid AI Desktop',
  listConversations: async () =>
    hasHook(HOOKS.extensionChatRequest)
      ? ((await callHookAsync<unknown[]>(HOOKS.extensionChatRequest, {
          action: 'conversations'
        })) ?? [])
      : getRagConversations()
          .slice(0, MAX_LISTED)
          .map((row) => toBridgeConversation(row, getRagMessages(row.id))),
  listConversationPage: readConversationPage,
  searchConversations: async (params): Promise<ConversationSearchResult> => {
    if (!hasHook(HOOKS.extensionChatRequest)) return plainConversationSearchPage(params)
    return (
      (await callHookAsync<ConversationSearchResult>(HOOKS.extensionChatRequest, {
        action: 'conversations',
        page: params
      })) ?? { conversations: [] }
    )
  },
  putConversation: async (raw, browser) => {
    const conversation = parseBridgeConversation(raw)
    if (!conversation) throw new Error('invalid')
    const existing = getRagConversation(conversation.id)
    const stored = getRagMessages(conversation.id)
    // An edit the desktop cannot apply is refused, never reported as synced.
    if (existing && historyConflicts(stored, conversation.turns)) throw new Error(HISTORY_CONFLICT)
    if (!existing) {
      createRagConversation(conversation.id, conversation.title)
      setBrowserConversationOrigin(getDB(), conversation.id, browser)
    } else {
      const title = newerBrowserTitle(existing, conversation)
      if (title) updateRagConversationTitle(conversation.id, title)
    }
    for (const turn of turnsToAppend(stored, conversation.turns)) {
      addRagMessage(conversation.id, turn.role, turn.content)
    }
    // The chat list reloads now, as it does for a phone's chats, not on the next restart.
    notifyRagConversationChanged({ conversationId: conversation.id })
  },
  deleteConversation: async (id) => {
    deleteRagConversation(id)
    notifyRagConversationChanged({ conversationId: id })
  },
  listTools: listBridgeTools,
  runTool: async (name, args, browser, tabId) => {
    const journeyId = journeyOf(browser)
    // A web task works in the tab its chat offered: the tab travels with that one task.
    const result = await runTool(
      name,
      args,
      {
        conversationId: journeyId,
        origin: 'bridge',
        acting: false,
        ...(tabId === undefined ? {} : { startTab: { browserId: browser.id, tabId } })
      },
      getToolExtensions()
    )
    const ok = result.status !== 'failed'
    // The accepted task's own id (web_use and computer_use), from the moment it is accepted.
    const taskId = ok ? result.taskId : undefined
    if (taskId) acceptedTasks.remember(taskId, journeyId)
    return { ok, output: result.text, ...(taskId ? { taskId } : {}) }
  },
  latestTask: async (browser, since, taskId) => {
    const journeyId = journeyOf(browser)
    if (taskId === undefined) return latestBrowserTask(listTaskRuns(20), journeyId, since)
    // Its own task, however many have started since; one not started yet shows as queued.
    return browserTaskById(getTaskRun(taskId) ?? null, acceptedTasks, journeyId, since, taskId)
  },
  stopTask: async (browser, taskId) => {
    const route = stopRoute(getTaskRun(taskId) ?? null, acceptedTasks, journeyOf(browser), taskId)
    if (route === 'running') return controlVisionTask('stop', taskId)
    // Accepted for this browser but not started (queued, awaiting approval): stopped as it starts.
    if (route === 'before-start') stopVisionTaskBeforeStart(taskId)
    return route === 'before-start'
  },
  setTaskRole: async (request) => {
    const { setTaskRoleFromRequest } = await import('../task-role-requests')
    return setTaskRoleFromRequest(request)
  },
  vault: async (request, browser) =>
    callHookAsync(HOOKS.extensionVaultRequest, request, {
      deviceName: browser.name,
      deviceId: browser.id
    }),
  readSettings: (section) => settingsStore.read(section),
  writeSettings: (section, patch) => settingsStore.write(section, patch)
}

let service: Promise<BridgeService> | null = null
const links = createLinkRegistry()

/** Browsers connected over the live socket right now, newest first. */
export function getBrowserLinks(): BrowserLink[] {
  return links.list()
}

/** Keep a browser's live link once its socket has passed the handshake. */
export function addBrowserLink(link: BrowserLink): void {
  // Pairing can be revoked while the socket handshake is in progress.
  if (!readFile()?.browsers.some((browser) => browser.id === link.browser.id)) {
    link.close()
    return
  }
  links.add(link)
}

/** The bridge, created on first use (after the app is ready, so safeStorage works). */
export function getBridgeService(): Promise<BridgeService> {
  service ??= loadOrCreateKeys().then(({ keys }) =>
    createBridgeService({
      keys,
      store: store(),
      confirmPairing,
      data,
      now: Date.now,
      newId: () => randomUUID().replace(/-/g, '')
    })
  )
  return service
}
