import { useEffect, useMemo, useState, useCallback, useRef, type ReactElement } from 'react'
import { ConnectorPullQueryField } from './ConnectorPullQueryField'
import { ConnectorSecretsForm } from './ConnectorSecretsForm'
import {
  IconLoader2,
  IconPlus,
  IconTrash,
  IconPlugConnected,
  IconAlertTriangle,
  IconCircleCheck,
  IconRefresh,
  IconChevronRight,
  IconChevronLeft,
  IconPencil,
  IconX
} from '@tabler/icons-react'
import {
  CONNECTOR_CATALOG,
  CATEGORY_ORDER,
  setupHintFor,
  type CatalogEntry
} from './connectorCatalog'
import slackLogo from '@/assets/logos/slack.svg'
import { getSlot, SLOTS } from '@/bootstrap/slotRegistry'
import { QuickConnections } from './QuickConnections'
import { QUICK_CONNECTION_IDS } from './quickConnectionCatalog'
import { CONNECTIONS_CHANGED_EVENT } from './useQuickConnection'
import { Segmented } from '@offgrid/operator-ui/operator/segmented'
import { PageHeader } from '@offgrid/operator-ui/operator/experience'
import { Button } from './ui/button'
import { GlyphSwap, IconTip } from './IconTip'
import { Skeleton } from '@offgrid/operator-ui/operator/coss/skeleton'
import { AnimatePresence, motion } from 'motion/react'
import {
  TagsInput,
  TagsInputInput,
  TagsInputItem,
  TagsInputLabel,
  TagsInputList
} from '@offgrid/operator-ui/operator/dice/tags-input'

// Brands Simple Icons dropped (trademark) → bundled local logos, keyed by catalog id.
const LOGO_OVERRIDE: Record<string, string> = { slack: slackLogo }

// BYO-OAuth setup form (e.g. Google client_id/secret) injected by pro. In the
// free build the slot is empty and this renders nothing. Reports whether the
// client is configured so the card can gate its Connect button.
function ConnectorSetup({
  entry,
  onReadyChange
}: {
  entry: CatalogEntry
  onReadyChange: (ready: boolean) => void
}): ReactElement | null {
  const Slot = getSlot(SLOTS.connectorSetup)
  if (entry.oauthClient !== 'byo' || !Slot) return null
  // The Pro slot is registered at runtime after the core bundle loads, so it must be resolved here.
  // eslint-disable-next-line react-hooks/static-components
  return <Slot entry={entry} onReadyChange={onReadyChange} />
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = (window as any).api

interface Connector {
  id: number
  name: string
  transport: 'stdio' | 'http'
  command: string | null
  args: string | null
  url: string | null
  enabled: number
  status: string
  status_detail: string | null
  /** Read live when asked; never synced into memory. */
  liveOnly?: boolean
  tools: string | null
  last_synced: number | null
  synced_count: number | null
}

// Simple Icons slugs → real brand logos via CDN. Missing/removed ones fall back
// to the colored letter badge. (Logos are UI chrome, not user data.)
const LOGO_SLUGS: Record<string, string> = {
  gmail: 'gmail',
  'google-calendar': 'googlecalendar',
  outlook: 'microsoftoutlook',
  slack: 'slack',
  discord: 'discord',
  zoom: 'zoom',
  whatsapp: 'whatsapp',
  notion: 'notion',
  confluence: 'confluence',
  coda: 'coda',
  obsidian: 'obsidian',
  linear: 'linear',
  jira: 'jira',
  asana: 'asana',
  clickup: 'clickup',
  trello: 'trello',
  monday: 'mondaydotcom',
  shortcut: 'shortcut',
  github: 'github',
  gitlab: 'gitlab',
  sentry: 'sentry',
  vercel: 'vercel',
  cloudflare: 'cloudflare',
  stripe: 'stripe',
  pagerduty: 'pagerduty',
  postgres: 'postgresql',
  figma: 'figma',
  canva: 'canva',
  posthog: 'posthog',
  amplitude: 'amplitude',
  mixpanel: 'mixpanel',
  intercom: 'intercom',
  hubspot: 'hubspot',
  salesforce: 'salesforce',
  attio: 'attio',
  'google-drive': 'googledrive',
  airtable: 'airtable',
  dropbox: 'dropbox',
  zapier: 'zapier'
}

/** Where a custom server lives, in a word: its host for a web server, its program for a local one.
 *  The full address (paths, query strings) and argument list stay in Edit. */
function serverHost(connector: Pick<Connector, 'transport' | 'url' | 'command'>): string {
  if (connector.transport === 'http') {
    try {
      return new URL(connector.url ?? '').hostname
    } catch {
      return ''
    }
  }
  return (connector.command ?? '').split(/[\\/]/).pop() ?? ''
}

/** A tool's id as words: `search_messages` reads "Search messages". */
function toolLabel(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name
}

// How to obtain credentials for token-based connectors (shown in the connect form).

// Turn raw transport errors into something human.
function cleanError(detail: string): string {
  const d = detail || ''
  if (
    /invalid_token|Missing or invalid access token|401|unauthorized|Authorization required/i.test(d)
  )
    return 'Sign-in required — click Test to authorize in your browser.'
  if (/<!DOCTYPE html|<html|404|not found/i.test(d)) return 'Endpoint not reachable.'
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|network/i.test(d)) return 'Could not reach the server.'
  return d.length > 140 ? d.slice(0, 140) + '…' : d
}

function Badge({
  id,
  color,
  letter
}: {
  id: string
  color: string
  letter: string
}): React.ReactElement {
  const slug = LOGO_SLUGS[id]
  const override = LOGO_OVERRIDE[id]
  const [failed, setFailed] = useState(false)
  const src = override ?? (slug ? `https://cdn.simpleicons.org/${slug}` : '')
  if (src && !failed) {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center">
        <img src={src} alt="" className="h-7 w-7 object-contain" onError={() => setFailed(true)} />
      </div>
    )
  }
  const dark = color.toLowerCase() === '#ffffff'
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-sm font-bold"
      style={{ backgroundColor: color, color: dark ? '#111' : '#fff' }}
    >
      {letter}
    </div>
  )
}

interface ConnectorConnectControlsProps {
  entry: CatalogEntry
  byoReady: boolean
  connecting: boolean
  error: string
  onConnect: () => void
  onCancel: () => void
}

function ConnectorConnectControls({
  entry,
  byoReady,
  connecting,
  error,
  onConnect,
  onCancel
}: Readonly<ConnectorConnectControlsProps>): ReactElement {
  const byoBlocked = entry.oauthClient === 'byo' && !byoReady
  const isAuthorizing = connecting && entry.auth === 'oauth'
  const progressLabel = isAuthorizing ? 'Authorize in browser…' : 'Connecting…'

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <div className="flex gap-1.5">
        <button
          onClick={onConnect}
          disabled={byoBlocked || connecting}
          title={
            byoBlocked
              ? 'Set up your Google client first'
              : entry.auth === 'oauth'
                ? 'Opens your browser to sign in'
                : undefined
          }
          className="flex h-7 items-center gap-1.5 rounded-md border border-neutral-700 px-2.5 text-xs text-neutral-200 transition-all duration-150 hover:border-green-500 hover:text-green-500 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-neutral-700 disabled:hover:text-neutral-200"
        >
          {connecting ? (
            <>
              <IconLoader2 className="h-3.5 w-3.5 animate-spin" /> {progressLabel}
            </>
          ) : (
            <>
              <IconPlugConnected className="h-3.5 w-3.5" /> Connect
            </>
          )}
        </button>
        {isAuthorizing && (
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel authorization"
            title="Cancel authorization"
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-neutral-700 text-neutral-400 transition-colors hover:border-red-500 hover:text-red-400"
          >
            <IconX className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {error && (
        <p className="max-w-56 text-right text-[11px] leading-relaxed text-red-400/80">{error}</p>
      )}
    </div>
  )
}

async function removePendingConnector(id: number | undefined): Promise<void> {
  if (id == null) return
  await api.mcpRemove?.(id)
}

async function persistConnectorSecrets(
  id: number | undefined,
  secretValues: Record<string, string>
): Promise<void> {
  if (id == null) return
  // Saved and recorded as what the connector receives, in one place (main/mcp.ts).
  await api.mcpSetSecrets?.(id, secretValues)
}

interface ConnectionOutcome {
  connected: boolean
  error?: string
}

async function settleConnectionAttempt(
  id: number | undefined,
  cancelled: boolean,
  result: { ok?: boolean; error?: string } | undefined
): Promise<ConnectionOutcome> {
  if (cancelled) {
    await removePendingConnector(id)
    return { connected: false }
  }
  if (result?.ok) return { connected: true }
  await removePendingConnector(id)
  return { connected: false, error: cleanError(result?.error ?? 'Could not connect') }
}

/**
 * A stdio server's arguments as tags, in order, repeats kept (`--allow a --allow b`). The stored
 * form stays the space-separated string the save path splits on whitespace, so a tag is one
 * argument: space finishes it, a pasted line splits on spaces, and text left in the field is kept
 * when it loses focus.
 */
function ArgsTagsField({
  value,
  onChange,
  label,
  placeholder
}: {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
}): ReactElement {
  const args = value.trim() ? value.trim().split(/\s+/) : []
  return (
    <TagsInput
      allowDuplicates
      value={args}
      onValueChange={(next) => onChange(next.join(' '))}
      delimiter=" "
      addOnPaste
      blurBehavior="add"
      className="w-full gap-1"
    >
      {label ? (
        <TagsInputLabel className="text-[11px] font-normal text-neutral-500">
          {label}
        </TagsInputLabel>
      ) : null}
      <TagsInputList className="min-h-9 border-neutral-800 bg-neutral-950 px-2 py-1.5 transition-[border-color,box-shadow] duration-300 focus-within:border-neutral-600 focus-within:ring-0">
        {args.map((arg, index) => (
          <TagsInputItem
            key={`${index}:${arg}`}
            value={arg}
            index={index}
            className="animate-[og-rise_420ms_var(--og-ease-spring)_both] rounded-md border-neutral-700 py-0.5 pl-2 font-mono text-[12px] text-neutral-200"
          >
            {arg}
          </TagsInputItem>
        ))}
        <TagsInputInput
          placeholder={placeholder}
          className="min-w-24 px-1 text-sm text-neutral-200"
        />
      </TagsInputList>
    </TagsInput>
  )
}

export function ConnectorsScreen(): ReactElement {
  const [items, setItems] = useState<Connector[]>([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [testingId, setTestingId] = useState<number | null>(null)
  const [syncingId, setSyncingId] = useState<number | null>(null)
  const [syncMsg, setSyncMsg] = useState<string>('')
  const [detailId, setDetailId] = useState<number | null>(null)
  const [tab, setTab] = useState<'all' | 'connected' | 'disconnected'>('all')
  const [syncedItems, setSyncedItems] = useState<
    { id: number; summary: string; ts: string; url: string | null }[]
  >([])
  const [connecting, setConnecting] = useState<string | null>(null)
  const pendingConnectorIds = useRef(new Map<string, number>())
  const connectsInFlight = useRef(new Set<string>())
  const cancelledConnections = useRef(new Set<string>())
  const [errorFor, setErrorFor] = useState<Record<string, string>>({})
  const [tokenFor, setTokenFor] = useState<CatalogEntry | null>(null)
  // Whether a BYO-OAuth connector has its client configured yet (reported by the
  // setup slot). Connect stays gated until it's true — no OAuth without a client.
  const [byoReady, setByoReady] = useState<Record<string, boolean>>({})

  // edit + remove in the detail view
  const [editing, setEditing] = useState(false)
  const [edit, setEdit] = useState({ name: '', url: '', command: '', args: '' })
  const [editError, setEditError] = useState('')
  const [changingToken, setChangingToken] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)

  // custom form
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'http'>('http')
  const [url, setUrl] = useState('')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setItems((await api.mcpList?.()) ?? [])
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
    const changed = (): void => {
      void load()
    }
    window.addEventListener(CONNECTIONS_CHANGED_EVENT, changed)
    return () => window.removeEventListener(CONNECTIONS_CHANGED_EVENT, changed)
  }, [load])

  // One way out of a connector's detail, shared by the back button and Escape.
  const closeDetail = useCallback((): void => {
    setDetailId(null)
    setEditing(false)
    setChangingToken(false)
    setConfirmRemove(false)
    void load()
  }, [load])
  useEffect(() => {
    if (detailId == null) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // Escape first dismisses what is open inside the detail (edit form, remove question).
      if (editing || confirmRemove || changingToken) {
        setEditing(false)
        setConfirmRemove(false)
        setChangingToken(false)
        return
      }
      closeDetail()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detailId, editing, confirmRemove, changingToken, closeDetail])

  // The gallery is every ready catalog connector that is not installed and not offered as a
  // direct account connection. It changes only when the installed list changes.
  const gallery = useMemo(() => {
    const installed = new Set(items.map((i) => i.name.toLowerCase()))
    const direct = Boolean(getSlot(SLOTS.quickConnectionProviders))
    return CONNECTOR_CATALOG.filter(
      (e) =>
        e.ready &&
        !QUICK_CONNECTION_IDS.includes(e.id) &&
        !(direct && ['gmail', 'google-calendar'].includes(e.id)) &&
        !installed.has(e.name.toLowerCase())
    )
  }, [items])

  const doConnect = async (
    entry: CatalogEntry,
    secretVals: Record<string, string>
  ): Promise<void> => {
    // One attempt per connector: a second would overwrite the first's pending id and cleanup.
    if (connectsInFlight.current.has(entry.id)) return
    connectsInFlight.current.add(entry.id)
    setConnecting(entry.id)
    cancelledConnections.current.delete(entry.id)
    setErrorFor((p) => ({ ...p, [entry.id]: '' }))
    let id: number | undefined
    try {
      id = await api.mcpAdd?.({
        name: entry.name,
        transport: entry.transport,
        url: entry.url,
        command: entry.command,
        args: entry.args,
        envKeys: entry.secrets?.map((s) => s.key)
      })
      if (id != null) pendingConnectorIds.current.set(entry.id, id)
      if (cancelledConnections.current.has(entry.id)) {
        await removePendingConnector(id)
        return
      }
      await persistConnectorSecrets(id, secretVals)
      const res = await api.mcpTest?.(id)
      const outcome = await settleConnectionAttempt(
        id,
        cancelledConnections.current.has(entry.id),
        res
      )
      if (outcome.connected) {
        // Truly connected → it moves into "Connected" and out of the gallery.
        // The secrets form closes with the card, and the typed secrets go with it.
        setTokenFor(null)
      } else if (outcome.error) {
        setErrorFor((p) => ({ ...p, [entry.id]: outcome.error ?? '' }))
      }
    } catch (e) {
      await removePendingConnector(id)
      if (!cancelledConnections.current.has(entry.id)) {
        setErrorFor((p) => ({
          ...p,
          [entry.id]: e instanceof Error ? e.message : 'Could not connect'
        }))
      }
    } finally {
      connectsInFlight.current.delete(entry.id)
      pendingConnectorIds.current.delete(entry.id)
      cancelledConnections.current.delete(entry.id)
      setConnecting(null)
      load()
    }
  }

  const cancelConnect = async (entryId: string): Promise<void> => {
    cancelledConnections.current.add(entryId)
    const connectorId = pendingConnectorIds.current.get(entryId)
    if (connectorId == null) return
    try {
      await api.mcpRemove?.(connectorId)
    } catch {
      // The in-flight connect owns final cleanup and will restore the card state.
    }
  }

  const onConnect = (entry: CatalogEntry): void => {
    if (entry.auth === 'token' && entry.secrets?.length) {
      setTokenFor(entry)
    } else {
      void doConnect(entry, {})
    }
  }

  const addCustom = async (): Promise<void> => {
    if (!name.trim()) return
    await api.mcpAdd?.({
      name: name.trim(),
      transport,
      url: transport === 'http' ? url.trim() : undefined,
      command: transport === 'stdio' ? command.trim() : undefined,
      args: transport === 'stdio' && args.trim() ? args.trim().split(/\s+/) : undefined
    })
    setName('')
    setUrl('')
    setCommand('')
    setArgs('')
    setAdding(false)
    load()
  }

  const test = async (id: number): Promise<void> => {
    setTestingId(id)
    try {
      await api.mcpTest?.(id)
    } finally {
      setTestingId(null)
      load()
    }
  }
  const toggle = async (id: number, enabled: boolean): Promise<void> => {
    await api.mcpSetEnabled?.(id, enabled)
    load()
  }
  const remove = async (id: number): Promise<void> => {
    await api.mcpRemove?.(id)
    load()
  }
  const startEdit = (c: Connector): void => {
    setEdit({
      name: c.name,
      url: c.url ?? '',
      command: c.command ?? '',
      args: c.args ? (JSON.parse(c.args) as string[]).join(' ') : ''
    })
    setEditError('')
    setChangingToken(false)
    setConfirmRemove(false)
    setEditing(true)
  }
  const saveEdit = async (c: Connector): Promise<void> => {
    setEditError('')
    try {
      await api.mcpUpdate?.(
        c.id,
        c.transport === 'http'
          ? { name: edit.name, url: edit.url }
          : {
              name: edit.name,
              command: edit.command,
              args: edit.args.trim() ? edit.args.trim().split(/\s+/) : []
            }
      )
      setEditing(false)
      window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT))
      load()
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Could not save the changes.')
    }
  }
  const changeToken = async (id: number, values: Record<string, string>): Promise<void> => {
    setTestingId(id)
    try {
      await persistConnectorSecrets(id, values)
      await api.mcpTest?.(id)
      setChangingToken(false)
    } finally {
      setTestingId(null)
      load()
    }
  }
  const sync = async (id: number, query?: string): Promise<void> => {
    setSyncingId(id)
    setSyncMsg('')
    try {
      const res = await api.mcpIngest?.(id, query)
      if (res && !res.ok) setSyncMsg(res.error ?? 'Sync failed')
      else if (res && res.count === 0) setSyncMsg('Synced — nothing new found.')
      else if (res) setSyncMsg(`Synced ${res.count} item${res.count === 1 ? '' : 's'}.`)
    } finally {
      setSyncingId(null)
      load()
      const c = items.find((x) => x.id === id)
      if (c) setSyncedItems((await api.mcpItems?.(c.name)) ?? [])
    }
  }
  const openDetail = async (c: Connector): Promise<void> => {
    setDetailId(c.id)
    setSyncedItems((await api.mcpItems?.(c.name)) ?? [])
  }
  const fmtAgo = (ms: number | null): string => {
    if (!ms) return 'never'
    const s = Math.floor((Date.now() - ms) / 1000)
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 font-mono">
      <PageHeader
        className="px-8 pt-8 pb-6"
        title="Integrations"
        description="Connect a tool. Actions it takes run only after you approve them."
        actions={
          <div className="flex items-center gap-3">
            {detailId == null && (
              <Segmented
                label="Filter connectors"
                size="sm"
                value={tab}
                onValueChange={setTab}
                options={(['all', 'connected', 'disconnected'] as const).map((t) => ({
                  id: t,
                  label: t === 'connected' && items.length > 0 ? `${t} ${items.length}` : t,
                  icon: (
                    <span className="capitalize">
                      {t}
                      {t === 'connected' && items.length > 0 && (
                        <span className="ml-1 text-neutral-500">{items.length}</span>
                      )}
                    </span>
                  )
                }))}
              />
            )}
            <IconTip label="Custom">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Custom"
                aria-expanded={adding}
                onClick={() => setAdding((v) => !v)}
              >
                <IconPlus className="h-4 w-4" />
              </Button>
            </IconTip>
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
        {detailId == null && tab !== 'connected' && (
          <div className="mb-10">
            <QuickConnections hideConnected={tab === 'disconnected'} />
          </div>
        )}
        {(() => {
          const detail = detailId != null ? items.find((c) => c.id === detailId) : null
          if (detail) {
            const dcat = CONNECTOR_CATALOG.find((x) => x.name === detail.name)
            const dNotReady =
              dcat != null &&
              !dcat.ready &&
              !(detail.tools && detail.tools !== '[]' && detail.url?.startsWith('offgrid-')) // preview/unverified — don't expose Test/Sync
            const dtools = detail.tools
              ? (JSON.parse(detail.tools) as { name: string; description?: string }[])
              : []
            return (
              <div className="mx-auto max-w-[1500px] space-y-5">
                <IconTip label="All integrations">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="All integrations"
                    onClick={closeDetail}
                    className="text-neutral-400 hover:text-white"
                  >
                    <IconChevronLeft className="h-4 w-4" />
                  </Button>
                </IconTip>
                <div className="flex items-start gap-3">
                  {dcat ? (
                    <Badge id={dcat.id} color={dcat.color} letter={dcat.letter} />
                  ) : (
                    <div className="h-9 w-9 shrink-0" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="text-lg tracking-tight text-white">{detail.name}</h2>
                      {dNotReady ? (
                        <span className="rounded-sm bg-neutral-800 px-1 py-0.5 text-[9px] uppercase tracking-wide text-neutral-500">
                          disabled · preview
                        </span>
                      ) : detail.status === 'ok' ? (
                        <span className="text-[11px] text-green-500">connected</span>
                      ) : detail.status === 'error' ? (
                        <span className="text-[11px] text-red-400">error</span>
                      ) : (
                        <span className="text-[11px] text-neutral-600">not tested</span>
                      )}
                    </div>
                    {/* What it is, in words. The server address or command is an internal detail; it
                        stays in Edit for a custom server. */}
                    <div className="truncate text-[11px] text-neutral-500">
                      {dcat ? dcat.blurb : serverHost(detail)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!dNotReady && (
                      <>
                        <IconTip label="Test">
                          <Button
                            variant="outline"
                            size="icon-sm"
                            aria-label="Test"
                            aria-busy={testingId === detail.id || undefined}
                            onClick={() => test(detail.id)}
                            disabled={testingId === detail.id}
                            className="border-neutral-700 text-neutral-300 hover:border-green-500 hover:text-green-500 disabled:opacity-50"
                          >
                            <GlyphSwap glyphKey={testingId === detail.id ? 'busy' : 'idle'}>
                              {testingId === detail.id ? (
                                <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <IconPlugConnected className="h-3.5 w-3.5" />
                              )}
                            </GlyphSwap>
                          </Button>
                        </IconTip>
                        <button
                          onClick={() => toggle(detail.id, !detail.enabled)}
                          className={`rounded-md px-2.5 py-1 text-xs ${detail.enabled ? 'text-green-500' : 'text-neutral-500'} hover:bg-neutral-800`}
                        >
                          {detail.enabled ? 'On' : 'Off'}
                        </button>
                      </>
                    )}
                    <IconTip label="Edit">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Edit"
                        onClick={() => startEdit(detail)}
                        className="text-neutral-300"
                      >
                        <IconPencil className="h-4 w-4" />
                      </Button>
                    </IconTip>
                    <IconTip label={`Remove ${detail.name}`}>
                      <button
                        aria-label={`Remove ${detail.name}`}
                        onClick={() => {
                          setEditing(false)
                          setConfirmRemove(true)
                        }}
                        className="rounded-md p-1 text-neutral-600 hover:text-red-400"
                      >
                        <IconTrash className="h-4 w-4" />
                      </button>
                    </IconTip>
                  </div>
                </div>
                {confirmRemove && (
                  <div
                    role="alertdialog"
                    aria-label={`Remove ${detail.name}?`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-neutral-800 p-3"
                  >
                    <p className="text-[11px] leading-4 text-neutral-400">
                      Remove {detail.name}? Off Grid AI forgets its settings and sign-in. Items
                      already saved to memory stay.
                    </p>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setConfirmRemove(false)}
                        className="rounded-md px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                      >
                        Keep
                      </button>
                      <button
                        onClick={async () => {
                          setConfirmRemove(false)
                          await remove(detail.id)
                          setDetailId(null)
                        }}
                        className="rounded-md bg-red-500/90 px-2.5 py-1 text-xs text-neutral-950 hover:bg-red-400"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
                {editing && (
                  <form
                    aria-label={`Edit ${detail.name}`}
                    className="space-y-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-3"
                    onSubmit={(event) => {
                      event.preventDefault()
                      void saveEdit(detail)
                    }}
                  >
                    <label className="block space-y-1 text-[11px] text-neutral-500">
                      Name
                      <input
                        value={edit.name}
                        onChange={(e) => setEdit((p) => ({ ...p, name: e.target.value }))}
                        className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600"
                      />
                    </label>
                    {detail.transport === 'http' ? (
                      <label className="block space-y-1 text-[11px] text-neutral-500">
                        Server address
                        <input
                          value={edit.url}
                          onChange={(e) => setEdit((p) => ({ ...p, url: e.target.value }))}
                          className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600"
                        />
                      </label>
                    ) : (
                      <>
                        <label className="block space-y-1 text-[11px] text-neutral-500">
                          Command
                          <input
                            value={edit.command}
                            onChange={(e) => setEdit((p) => ({ ...p, command: e.target.value }))}
                            className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600"
                          />
                        </label>
                        <ArgsTagsField
                          label="Arguments"
                          value={edit.args}
                          onChange={(args) => setEdit((p) => ({ ...p, args }))}
                        />
                      </>
                    )}
                    <p className="text-[11px] leading-4 text-neutral-500">
                      A new address or command signs out of the old server. Test the connection
                      after saving.
                    </p>
                    {editError && <p className="text-[11px] text-red-400/80">{editError}</p>}
                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        className="rounded-md bg-green-500 px-3 py-1.5 text-xs text-neutral-950 hover:bg-green-400"
                      >
                        Save
                      </button>
                      <IconTip label="Cancel">
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-sm"
                          aria-label="Cancel"
                          onClick={() => setEditing(false)}
                          className="border-neutral-700 text-neutral-300"
                        >
                          <IconX className="h-3.5 w-3.5" />
                        </Button>
                      </IconTip>
                    </div>
                  </form>
                )}
                {editing && dcat?.auth === 'token' && dcat.secrets?.length ? (
                  <div className="space-y-2">
                    {changingToken ? (
                      <ConnectorSecretsForm
                        secrets={dcat.secrets}
                        connecting={testingId === detail.id}
                        onConnect={(values) => void changeToken(detail.id, values)}
                        onCancel={() => setChangingToken(false)}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => setChangingToken(true)}
                        className="text-xs text-green-500 hover:underline"
                      >
                        Change token
                      </button>
                    )}
                  </div>
                ) : null}
                {dNotReady && (
                  <p className="text-[11px] text-neutral-500">
                    This integration isn&apos;t verified yet — connect/test/sync are disabled. You
                    can remove this entry.
                  </p>
                )}
                {!dNotReady && detail.status === 'error' && detail.status_detail && (
                  <p className="text-[11px] text-red-400/80">{cleanError(detail.status_detail)}</p>
                )}

                {!dNotReady && detail.status === 'ok' && detail.liveOnly && (
                  <p className="text-[11px] leading-relaxed text-neutral-500">
                    Read live when you ask. Nothing from this account is saved to memory.
                  </p>
                )}
                {!dNotReady && detail.status === 'ok' && !detail.liveOnly && (
                  <div className="flex items-center gap-2">
                    <IconTip label="Sync recent">
                      <Button
                        size="icon-sm"
                        aria-label="Sync recent"
                        aria-busy={syncingId === detail.id || undefined}
                        onClick={() => sync(detail.id)}
                        disabled={syncingId === detail.id}
                        className="shrink-0 bg-green-500/90 text-neutral-950 hover:bg-green-400 disabled:opacity-50"
                      >
                        <IconRefresh
                          className={`h-3.5 w-3.5 ${syncingId === detail.id ? 'animate-spin' : ''}`}
                        />
                      </Button>
                    </IconTip>
                    <ConnectorPullQueryField
                      key={detail.id}
                      connectorName={detail.name}
                      disabled={syncingId === detail.id}
                      onPull={(query) => void sync(detail.id, query)}
                    />
                  </div>
                )}
                {syncMsg && (
                  <p className="text-[11px] leading-relaxed text-neutral-400">{syncMsg}</p>
                )}

                <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                  {/* Synced data — the meat (wide) */}
                  <section className="lg:col-span-2">
                    <h3 className="mb-2 text-[11px] uppercase tracking-wide text-neutral-500">
                      Synced data · {(detail.synced_count ?? 0).toLocaleString()} items
                    </h3>
                    {syncedItems.length === 0 ? (
                      <p className="text-xs text-neutral-600">
                        Nothing yet. Sync, or pull something specific.
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {syncedItems.map((it) => (
                          <div key={it.id} className="flex items-start gap-2 text-xs">
                            <span className="shrink-0 text-neutral-600">{it.ts.slice(5, 16)}</span>
                            {it.url ? (
                              <a
                                href={it.url}
                                target="_blank"
                                rel="noreferrer"
                                className="text-green-500 hover:underline"
                              >
                                {it.summary} ↗
                              </a>
                            ) : (
                              <span className="text-neutral-300">{it.summary}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* Tools (narrow side column) */}
                  {dtools.length > 0 && (
                    <section className="lg:col-span-1">
                      <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-neutral-500">
                        Tools · {dtools.length}
                      </h3>
                      <div className="flex flex-wrap gap-1">
                        {dtools.map((t) => (
                          <span
                            key={t.name}
                            title={t.description}
                            className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400"
                          >
                            {toolLabel(t.name)}
                          </span>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
              </div>
            )
          }
          return (
            <div className="mx-auto max-w-[1600px] space-y-6">
              {/* Custom (advanced) form */}
              {adding && (
                <div className="space-y-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Name"
                    className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600"
                  />
                  <Segmented
                    label="Transport"
                    size="sm"
                    className="w-fit"
                    value={transport}
                    onValueChange={setTransport}
                    options={[
                      { id: 'http', label: 'HTTP / SSE' },
                      { id: 'stdio', label: 'stdio (local)' }
                    ]}
                  />
                  {transport === 'http' ? (
                    <input
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      placeholder="https://mcp.example.com/endpoint"
                      className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600"
                    />
                  ) : (
                    <>
                      <input
                        value={command}
                        onChange={(e) => setCommand(e.target.value)}
                        placeholder="command (e.g. npx)"
                        className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-200 outline-none focus:border-neutral-600"
                      />
                      <ArgsTagsField value={args} onChange={setArgs} placeholder="args" />
                    </>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={addCustom}
                      className="rounded-md bg-green-500 px-3 py-1.5 text-xs text-neutral-950 hover:bg-green-400"
                    >
                      Add
                    </button>
                    <IconTip label="Cancel">
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label="Cancel"
                        onClick={() => setAdding(false)}
                        className="border-neutral-700 text-neutral-300"
                      >
                        <IconX className="h-3.5 w-3.5" />
                      </Button>
                    </IconTip>
                  </div>
                </div>
              )}

              {/* CATALOG GALLERY — grouped by category (Disconnected) */}
              {tab !== 'connected' &&
                CATEGORY_ORDER.map((cat) => {
                  const entries = gallery.filter((e) => e.category === cat)
                  if (entries.length === 0) return null
                  return (
                    <section key={cat}>
                      <h2 className="mb-3 text-[10px] uppercase tracking-widest text-neutral-500">
                        {cat}
                      </h2>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                        {entries.map((e) => (
                          <div
                            key={e.id}
                            className={`flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 p-3 ${!e.ready ? 'opacity-55' : ''}`}
                          >
                            <div className="flex items-center gap-3">
                              <Badge id={e.id} color={e.color} letter={e.letter} />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-sm text-neutral-100">{e.name}</span>
                                  {!e.ready && (
                                    <span className="rounded-sm bg-neutral-800 px-1 py-0.5 text-[9px] uppercase tracking-wide text-neutral-500">
                                      disabled
                                    </span>
                                  )}
                                </div>
                                <p className="truncate text-[11px] text-neutral-500">{e.blurb}</p>
                              </div>
                              {/* Connect sits on the row, as it does for the tools above; only a
                                  token form opens below it. */}
                              {e.ready && tokenFor?.id !== e.id ? (
                                <ConnectorConnectControls
                                  entry={e}
                                  byoReady={Boolean(byoReady[e.id])}
                                  connecting={connecting === e.id}
                                  error={errorFor[e.id] ?? ''}
                                  onConnect={() => onConnect(e)}
                                  onCancel={() => void cancelConnect(e.id)}
                                />
                              ) : null}
                            </div>
                            {e.ready && (
                              <ConnectorSetup
                                entry={e}
                                onReadyChange={(r) =>
                                  setByoReady((p) => (p[e.id] === r ? p : { ...p, [e.id]: r }))
                                }
                              />
                            )}
                            {/* The "disabled" badge beside the name is the one indicator here. */}
                            {e.ready && tokenFor?.id === e.id ? (
                              <div className="space-y-2">
                                {(setupHintFor(e.id) || e.docsUrl) && (
                                  <p className="text-[11px] leading-relaxed text-neutral-500">
                                    {setupHintFor(e.id)}{' '}
                                    {e.docsUrl && (
                                      <a
                                        href={e.docsUrl}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="text-green-500 hover:underline"
                                      >
                                        How to get this →
                                      </a>
                                    )}
                                  </p>
                                )}
                                <ConnectorSecretsForm
                                  secrets={e.secrets ?? []}
                                  onConnect={(secrets) => void doConnect(e, secrets)}
                                  onCancel={() => setTokenFor(null)}
                                  connecting={connecting === e.id}
                                />
                              </div>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    </section>
                  )
                })}

              {/* INSTALLED (Connected) */}
              {tab !== 'disconnected' && (
                <section>
                  <h2 className="mb-3 text-[10px] uppercase tracking-widest text-neutral-500">
                    Connected
                  </h2>
                  {loading && items.length === 0 ? (
                    <div className="space-y-2" aria-busy="true" aria-label="Loading connections">
                      {[0, 1, 2].map((i) => (
                        <Skeleton key={i} className="h-[52px] w-full rounded-md" />
                      ))}
                    </div>
                  ) : items.length === 0 ? (
                    <p className="py-5 text-xs text-neutral-600">
                      Nothing connected yet. Pick one above.
                    </p>
                  ) : (
                    <div className="divide-y divide-neutral-800 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900/40">
                      <AnimatePresence initial={false}>
                        {items.map((c) => {
                          const cat = CONNECTOR_CATALOG.find((x) => x.name === c.name)
                          // Preview catalog entries stay disabled. A verified internal local provider
                          // can supply working tools without that catalog's third-party server.
                          const notReady =
                            cat != null &&
                            !cat.ready &&
                            !(c.tools && c.tools !== '[]' && c.url?.startsWith('offgrid-'))
                          return (
                            <motion.button
                              key={c.id}
                              layout
                              initial={{ opacity: 0, y: 6 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0 }}
                              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                              onClick={() => openDetail(c)}
                              className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-neutral-800/40 ${notReady ? 'opacity-55' : ''}`}
                            >
                              {cat ? (
                                <Badge id={cat.id} color={cat.color} letter={cat.letter} />
                              ) : (
                                <div className="h-9 w-9 shrink-0" />
                              )}
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm text-neutral-100">{c.name}</span>
                                  {notReady ? (
                                    <span className="rounded-sm bg-neutral-800 px-1 py-0.5 text-[9px] uppercase tracking-wide text-neutral-500">
                                      disabled · preview
                                    </span>
                                  ) : c.status === 'ok' ? (
                                    <span className="flex items-center gap-1 text-[11px] text-green-500">
                                      <IconCircleCheck className="h-3.5 w-3.5" /> connected
                                    </span>
                                  ) : c.status === 'error' ? (
                                    <span className="flex items-center gap-1 text-[11px] text-red-400">
                                      <IconAlertTriangle className="h-3.5 w-3.5" /> error
                                    </span>
                                  ) : (
                                    <span className="text-[11px] text-neutral-600">not tested</span>
                                  )}
                                </div>
                                <div className="text-[11px] text-neutral-500">
                                  {notReady
                                    ? 'Integration not verified yet'
                                    : `${c.synced_count ?? 0} items synced · last ${fmtAgo(c.last_synced)}`}
                                </div>
                              </div>
                              <IconChevronRight className="h-4 w-4 shrink-0 text-neutral-600" />
                            </motion.button>
                          )
                        })}
                      </AnimatePresence>
                    </div>
                  )}
                </section>
              )}
            </div>
          )
        })()}
      </div>
    </div>
  )
}
