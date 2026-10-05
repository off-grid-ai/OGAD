// The real dependencies for the extension bridge: key storage (encrypted at rest by the OS),
// the native confirm dialog, OGAD's chat tables, the live tool registry, and Pro gating.
//
// What a browser can reach follows what THIS desktop actually has: chats and MCP connectors are
// core; the native action tools and the vault exist only when Pro is active, because only then
// are they registered. Nothing here grants a browser more than the desktop app itself has.

import { listTaskRuns } from '../tasks/task-history'
import { browserTaskProgress } from './task-progress'
import { controlVisionTask } from '../vision/vision-controller'
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
  getRagConversations,
  getRagMessages,
  getSettings,
  saveSetting
} from '../database'
import { getToolExtensions, runTool } from '../tools'
import { notifyRagConversationChanged } from '../rag-conversation-events'
import { callHookAsync, hasHook, HOOKS } from '../bootstrap/hookRegistry'
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
  getRemoteVisionServerSettings
} from '../vision/remote-vision-server'
import { remoteModelSelected } from '../active-models'
import {
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
  MAX_LISTED,
  parseBridgeConversation,
  toBridgeConversation,
  turnsToAppend
} from './bridge-conversations'
import { generateKeyPair } from './bridge-protocol'
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
      if (file) writeFile({ ...file, browsers: [...browsers] })
    }
  }
}

const PAIR_TIMEOUT_MS = 120_000

async function confirmPairing(code: string, deviceName: string): Promise<boolean> {
  const win = BrowserWindow.getAllWindows()[0]
  win?.show()
  win?.focus()
  const options = {
    type: 'question' as const,
    buttons: ['Pair', "Don't pair"],
    defaultId: 1,
    cancelId: 1,
    title: 'Pair a browser',
    message: `Pair "${deviceName}" with Off Grid AI Desktop?`,
    detail:
      `Only continue if your browser shows these same words:\n\n${code}\n\n` +
      'The browser can then use your chats, tools and (with Pro) vault through an encrypted, ' +
      'private link on this computer. It does not count as one of your devices.'
  }
  const shown = win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  const timeout = new Promise<{ response: number }>((resolve) =>
    setTimeout(() => resolve({ response: 1 }), PAIR_TIMEOUT_MS)
  )
  return (await Promise.race([shown, timeout])).response === 0
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
    chats: true,
    tools: exts.some((e) => e.category === 'tool'),
    connectors: exts.some((e) => e.category !== 'tool'),
    vault: pro && hasHook(HOOKS.extensionVaultRequest),
    // Keep the live socket open only while tasks are set to use the default browser.
    browserTasks: getWebUseSettings().browserTarget === 'default_browser'
  }
}

async function listTools(): Promise<unknown[]> {
  const out: unknown[] = []
  for (const ext of getToolExtensions()) {
    const source = ext.category === 'tool' ? 'native' : 'connector'
    for (const schema of await ext.schemas()) {
      const fn = (
        schema as { function?: { name?: unknown; description?: unknown; parameters?: unknown } }
      ).function
      if (typeof fn?.name === 'string') {
        out.push({
          name: fn.name,
          description: typeof fn.description === 'string' ? fn.description : '',
          parameters: fn.parameters ?? { type: 'object', properties: {} },
          source,
          ...(source === 'connector' ? { connector: ext.id } : {})
        })
      }
    }
  }
  return out
}

// The same functions Settings here uses, so a browser and this window always agree.
const settingsStore = createSettingsStore({
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
    const [catalog, installed] = await Promise.all([getCatalog(), listInstalled()])
    const active = (getActiveModalities() as Record<string, string | null>).computer_use
    return {
      catalog: catalog.models as Record<string, unknown>[],
      installed,
      activeGrounder: active ?? null
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
  addConnector: (c) => void addConnector(c),
  setConnectorEnabled,
  removeConnector,
  activeImageModel: () => {
    const status = imageGenStatus()
    return status.active ?? status.models[0] ?? null
  },
  imageParams: (model, store) =>
    resolveImageParameters({ id: model }, store as Parameters<typeof resolveImageParameters>[1]),
  setImageParam: (store, model, key, value) =>
    setImageParameterOverride(
      store as Parameters<typeof setImageParameterOverride>[0],
      model,
      key,
      value
    ),
  transcription: readTranscriptionInfo
})

const data: BridgeData = {
  features,
  desktopName: () => 'Off Grid AI Desktop',
  listConversations: async () =>
    getRagConversations()
      .slice(0, MAX_LISTED)
      .map((row) => toBridgeConversation(row, getRagMessages(row.id))),
  putConversation: async (raw, browser) => {
    const conversation = parseBridgeConversation(raw)
    if (!conversation) throw new Error('invalid')
    if (!getRagConversation(conversation.id)) {
      createRagConversation(conversation.id, conversation.title)
      getDB()
        .prepare(
          'UPDATE rag_conversations SET origin_device_id = ?, origin_device_name = ? WHERE id = ?'
        )
        .run(`${BROWSER_ORIGIN_PREFIX}${browser.id}`, browser.name, conversation.id)
    }
    for (const turn of turnsToAppend(getRagMessages(conversation.id), conversation.turns)) {
      addRagMessage(conversation.id, turn.role, turn.content)
    }
    // The chat list reloads now, as it does for a phone's chats, not on the next restart.
    notifyRagConversationChanged({ conversationId: conversation.id })
  },
  deleteConversation: async (id) => {
    deleteRagConversation(id)
    notifyRagConversationChanged({ conversationId: id })
  },
  listTools,
  runTool: async (name, args, browser) => {
    const result = await runTool(
      name,
      args,
      { conversationId: `${BROWSER_ORIGIN_PREFIX}${browser.id}` },
      getToolExtensions()
    )
    return { ok: result.status !== 'failed', output: result.text }
  },
  latestTask: async (browser, since) => {
    const run = listTaskRuns(20).find(
      (task) =>
        task.journeyId === `${BROWSER_ORIGIN_PREFIX}${browser.id}` && task.startedAt >= since
    )
    return run ? browserTaskProgress(run) : null
  },
  stopTask: async (browser, taskId) => {
    const run = listTaskRuns(50).find((task) => task.taskId === taskId)
    // Only a task this browser started: a paired browser never stops another's work.
    return run?.journeyId === `${BROWSER_ORIGIN_PREFIX}${browser.id}`
      ? controlVisionTask('stop', taskId)
      : false
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
