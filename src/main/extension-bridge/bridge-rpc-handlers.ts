import { chatHandlers } from './bridge-chat-handlers'
import { bridgeMediaData, mediaHandlers } from './bridge-media-handlers'
import { parseConversationParams, type ConversationSearchParams } from './bridge-conversations'
import { isSettingsSection, parseSettingsPatch } from './bridge-settings'
import type { BridgeFeatures, RpcMethod } from './bridge-protocol'
import type { BridgeDeps, PairedBrowser } from './bridge-types'

const isTaskId = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w-]{1,128}$/.test(value)
type Handler = (params: Record<string, unknown>, browser: PairedBrowser) => Promise<unknown>

export function rpcHandlers(
  deps: BridgeDeps,
  forgetSession: (id: string) => void
): Record<RpcMethod, Handler> {
  const requireFeature = (feature: keyof BridgeFeatures): void => {
    const features = deps.data.features()
    if (features[feature]) return
    const proOnly = feature === 'vault' || feature === 'tools'
    throw new Error(proOnly && !features.pro ? 'pro_required' : `${feature}_unavailable`)
  }

  return {
    ...chatHandlers(deps.data.chat),
    ...mediaHandlers({ ...bridgeMediaData, ...deps.data }),
    state: async (_p, browser) => ({
      desktopName: deps.data.desktopName(),
      deviceName: browser.name,
      features: deps.data.features()
    }),
    'conversations.list': async (p) => {
      const params = parseConversationParams(p, false)
      if (!Object.keys(p).length) return deps.data.listConversations()
      if (!deps.data.listConversationPage) throw new Error('chats_unavailable')
      return deps.data.listConversationPage(params)
    },
    'conversations.search': async (p) => {
      const params = parseConversationParams(p, true) as ConversationSearchParams
      if (!deps.data.searchConversations) throw new Error('chats_unavailable')
      return deps.data.searchConversations(params)
    },
    'conversations.put': async (p, browser) => {
      await deps.data.putConversation(p.conversation, browser)
      return true
    },
    'conversations.delete': async (p) => {
      if (typeof p.id !== 'string' || !p.id) {
        throw new Error('invalid')
      }
      await deps.data.deleteConversation(p.id)
      return true
    },
    'tools.list': async (p) => {
      if (p.task !== undefined && (typeof p.task !== 'string' || p.task.length > 32_000)) {
        throw new Error('invalid')
      }
      return deps.data.listTools(typeof p.task === 'string' ? p.task : undefined)
    },
    'tools.run': async (p, browser) => {
      if (typeof p.name !== 'string' || typeof p.args !== 'object' || p.args === null) {
        throw new Error('invalid')
      }
      const tabId = p.tabId
      if (tabId !== undefined && !(Number.isSafeInteger(tabId) && Number(tabId) >= 0)) {
        throw new Error('invalid')
      }
      // Direct tool calls from a paired browser run only the read-only tools Desktop lists.
      // Acting tools run only inside a Desktop-owned chat run. Tools turned off since listing never run.
      const name = p.name
      const listed = (await deps.data.listTools()).some(
        (tool) => (tool as { name?: unknown }).name === name
      )
      if (!listed) {
        requireFeature('tools')
        throw new Error('tool_unavailable')
      }
      return deps.data.runTool(
        p.name,
        p.args as Record<string, unknown>,
        browser,
        tabId === undefined ? undefined : Number(tabId)
      )
    },
    'tasks.latest': async (p, browser) => {
      requireFeature('tools')
      if (typeof p.since !== 'number' || !Number.isFinite(p.since)) {
        throw new Error('invalid')
      }
      if (p.taskId !== undefined && !isTaskId(p.taskId)) {
        throw new Error('invalid')
      }
      return deps.data.latestTask(browser, p.since, p.taskId)
    },
    'tasks.stop': async (p, browser) => {
      // A browser can still stop its own task after Pro access ends.
      if (!isTaskId(p.taskId)) {
        throw new Error('invalid')
      }
      return deps.data.stopTask(browser, p.taskId)
    },
    'models.setTaskRole': async (p) => {
      const result = await deps.data.setTaskRole({ task: p.task, role: p.role, modelId: p.modelId })
      if (!result.success) throw new Error(result.error ?? 'invalid')
      return result
    },
    vault: async (p, browser) => {
      requireFeature('vault')
      return deps.data.vault(p.request, browser)
    },
    'settings.get': async (p) => {
      if (!isSettingsSection(p.section)) {
        throw new Error('invalid')
      }
      return deps.data.readSettings(p.section)
    },
    'settings.set': async (p) => {
      const patch = isSettingsSection(p.section) ? parseSettingsPatch(p.section, p.patch) : null
      if (!patch || !isSettingsSection(p.section)) {
        throw new Error('invalid')
      }
      await deps.data.writeSettings(p.section, patch)
      return deps.data.readSettings(p.section)
    },
    unpair: async (_p, browser) => {
      await deps.data.chat?.({ action: 'disconnect' }, browser).catch(() => undefined)
      const all = await deps.store.list()
      await deps.store.save(all.filter((b) => b.id !== browser.id))
      forgetSession(browser.id)
      return true
    }
  }
}
