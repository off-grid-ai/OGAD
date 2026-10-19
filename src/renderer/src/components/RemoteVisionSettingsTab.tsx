import { useEffect, useMemo, useState } from 'react'
import { isGrounderModel, modelDisplayName } from '@offgrid/models'
import {
  remoteVisionApiBase,
  remoteVisionModelId,
  remoteVisionProviderForEndpoint,
  type RemoteVisionConnectionResult,
  type RemoteVisionCatalogModel,
  type RemoteVisionSelections,
  type RemoteVisionRoleSelections,
  type RemoteVisionSavedServer,
  type RemoteVisionServerSettings,
  type RemoteVisionServerUpdate
} from '../../../shared/remote-vision-server'
import { providerNeedsScreenDisclosure } from '../../../shared/remote-screen-privacy'
import { SettingsRow as Row } from './SettingsRow'
import { SettingsSelect } from './SettingsSelect'
import { SettingsSection } from './SettingsSection'
import { AnimatePresence, motion } from 'motion/react'
import { Switch } from '@offgrid/operator-ui/operator/animate/switch'
import { LiveStatus } from '@offgrid/operator-ui/operator/presence'
import { Badge } from '@offgrid/operator-ui/operator/coss/badge'
import { ListRow } from '@offgrid/operator-ui/operator/list-row'
import { PencilSimple, Plus, Trash } from '@phosphor-icons/react'
import { Button } from './ui/button'
import { IconTip } from './IconTip'

const EMPTY_SETTINGS: RemoteVisionServerSettings = {
  provider: 'local',
  endpoint: '',
  model: '',
  hasApiKey: false,
  activeServerId: null,
  servers: []
}

interface ServerForm {
  id: string | null
  name: string
  endpoint: string
  model: string
  mediaModels: RemoteVisionSelections
  roleModels: RemoteVisionRoleSelections
  modelCatalog: RemoteVisionCatalogModel[]
  hasApiKey: boolean
  screenFramesAllowed: boolean
}

const EMPTY_FORM: ServerForm = {
  id: null,
  name: '',
  endpoint: '',
  model: '',
  mediaModels: {},
  roleModels: {},
  modelCatalog: [],
  hasApiKey: false,
  screenFramesAllowed: false
}

function formFromServer(server: RemoteVisionSavedServer): ServerForm {
  return {
    id: server.id,
    name: server.name,
    endpoint: server.endpoint,
    model: server.model,
    mediaModels: server.mediaModels ?? { text: server.model },
    roleModels: server.roleModels ?? {},
    modelCatalog: server.modelCatalog ?? [],
    hasApiKey: server.hasApiKey,
    screenFramesAllowed: server.screenFramesAllowed
  }
}

function serverNameFromEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return 'Remote server'
  }
}

function normalizeSettings(value: RemoteVisionServerSettings): RemoteVisionServerSettings {
  if (Array.isArray(value.servers)) return value
  const legacyServer: RemoteVisionSavedServer | null =
    value.provider !== 'local' && value.endpoint && value.model
      ? {
          id: 'migrated-server',
          name: serverNameFromEndpoint(value.endpoint),
          provider: value.provider,
          endpoint: value.endpoint,
          model: value.model,
          hasApiKey: value.hasApiKey,
          screenFramesAllowed: false
        }
      : null
  return {
    ...value,
    activeServerId: legacyServer?.id ?? null,
    servers: legacyServer ? [legacyServer] : []
  }
}

/** A model's name, read by the shared resolver: the server's advertised name, else a clean id. */
function catalogModelName(catalog: RemoteVisionCatalogModel[] | undefined, id: string): string {
  return (
    modelDisplayName(remoteVisionModelId('form', id), {
      remote: [{ serverId: 'form', models: catalog ?? [] }]
    }) ?? id
  )
}

export function RemoteVisionSettingsTab(): React.JSX.Element {
  const [settings, setSettings] = useState(EMPTY_SETTINGS)
  const [form, setForm] = useState<ServerForm>(EMPTY_FORM)
  const [remoteEnabled, setRemoteEnabled] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<RemoteVisionCatalogModel[]>([])
  const [modelQuery, setModelQuery] = useState('')
  const [showModels, setShowModels] = useState(false)
  const [status, setStatus] = useState('Checking saved settings')
  const [busy, setBusy] = useState(false)

  const selectServer = (server: RemoteVisionSavedServer): void => {
    setForm(formFromServer(server))
    setApiKey('')
    setModels(
      server.modelCatalog ??
        (server.model ? [{ id: server.model, name: server.model, kind: 'text' }] : [])
    )
    setModelQuery(catalogModelName(server.modelCatalog, server.model))
    setShowModels(false)
    setStatus(server.id === settings.activeServerId ? 'This server is active.' : 'Ready to edit.')
  }

  const applySettings = (value: RemoteVisionServerSettings): void => {
    const normalized = normalizeSettings(value)
    setSettings(normalized)
    setRemoteEnabled(normalized.activeServerId !== null)
    const selected =
      normalized.servers.find((server) => server.id === normalized.activeServerId) ??
      normalized.servers[0]
    if (selected) selectServer(selected)
    else {
      setForm(EMPTY_FORM)
      setModels([])
      setModelQuery('')
    }
  }

  useEffect(() => {
    window.api
      .getRemoteVisionServer()
      .then((value: RemoteVisionServerSettings) => {
        const normalized = normalizeSettings(value)
        setSettings(normalized)
        setRemoteEnabled(normalized.activeServerId !== null)
        const selected =
          normalized.servers.find((server) => server.id === normalized.activeServerId) ??
          normalized.servers[0]
        if (selected) {
          setForm(formFromServer(selected))
          setModels(
            selected.modelCatalog ??
              (selected.model ? [{ id: selected.model, name: selected.model, kind: 'text' }] : [])
          )
          setModelQuery(catalogModelName(selected.modelCatalog, selected.model))
        }
        setStatus(normalized.activeServerId ? 'Remote server is active.' : 'Local model is active.')
      })
      .catch(() => setStatus('Remote server settings could not be read.'))
  }, [])

  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase()
    return models
      .filter(
        (model) =>
          model.kind === 'text' &&
          !model.outputModalities?.includes('decisions') &&
          !isGrounderModel(model.id) &&
          (!query ||
            `${model.name} ${model.id} ${catalogModelName(models, model.id)}`
              .toLowerCase()
              .includes(query))
      )
      .slice(0, 75)
  }, [modelQuery, models])

  const payload = (): RemoteVisionServerUpdate => {
    if (!remoteEnabled) return { provider: 'local', endpoint: '', model: '' }
    const endpoint = remoteVisionApiBase(form.endpoint)
    return {
      provider: remoteVisionProviderForEndpoint(endpoint),
      endpoint,
      model: form.model,
      mediaModels: form.mediaModels,
      roleModels: form.roleModels,
      modelCatalog: form.modelCatalog,
      serverId: form.id ?? undefined,
      name: form.name,
      ...(apiKey ? { apiKey } : {}),
      screenFramesAllowed: form.screenFramesAllowed
    }
  }

  const discoverModels = async (
    update: RemoteVisionServerUpdate,
    selectedModel: string
  ): Promise<void> => {
    setBusy(true)
    setStatus('Loading models...')
    try {
      const result = (await window.api.testRemoteVisionServer(
        update
      )) as RemoteVisionConnectionResult
      if (!result.ok) {
        setStatus(result.error || 'Connection failed.')
        return
      }
      const discovered = result.models ?? []
      const nextModel = discovered.some(
        (model) => model.id === selectedModel && model.kind === 'text'
      )
        ? selectedModel
        : ''
      setModels(discovered)
      setForm((current) => ({
        ...current,
        model: nextModel,
        modelCatalog: discovered,
        mediaModels: Object.fromEntries(
          (['text', 'image', 'transcription', 'voice'] as const).flatMap((kind) => {
            const id = kind === 'text' ? nextModel : current.mediaModels[kind]
            return id && discovered.some((model) => model.id === id && model.kind === kind)
              ? [[kind, id]]
              : []
          })
        ) as RemoteVisionSelections,
        roleModels: Object.fromEntries(
          (['grounding', 'decision'] as const).flatMap((role) => {
            const id = current.roleModels[role]
            return id && discovered.some((model) => model.id === id && model.kind === 'text')
              ? [[role, id]]
              : []
          })
        ) as RemoteVisionRoleSelections
      }))
      setModelQuery(catalogModelName(discovered, nextModel))
      setShowModels(true)
      setStatus(
        discovered.length > 0
          ? `Connected in ${result.latencyMs} ms. ${discovered.length} model${discovered.length === 1 ? '' : 's'} found.`
          : `Connected in ${result.latencyMs} ms, but no models were found.`
      )
    } catch {
      setStatus('Connection failed.')
    } finally {
      setBusy(false)
    }
  }

  const test = async (): Promise<void> => {
    if (!form.endpoint.trim()) {
      setStatus('Enter a server address first.')
      return
    }
    await discoverModels(payload(), form.model)
  }

  const changeModel = async (server: RemoteVisionSavedServer): Promise<void> => {
    selectServer(server)
    setRemoteEnabled(true)
    await discoverModels(
      {
        provider: server.provider,
        endpoint: server.endpoint,
        model: server.model,
        serverId: server.id,
        name: server.name
      },
      server.model
    )
    requestAnimationFrame(() => {
      const input = document.getElementById('remote-server-model-search')
      const scrollable = input as {
        scrollIntoView?: (options?: ScrollIntoViewOptions) => void
      } | null
      scrollable?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
      input?.focus()
    })
  }

  const save = async (): Promise<void> => {
    if (remoteEnabled && !form.name.trim()) {
      setStatus('Enter a server name first.')
      return
    }
    if (
      remoteEnabled &&
      ![...Object.values(form.mediaModels), ...Object.values(form.roleModels)].some(Boolean)
    ) {
      setStatus('Test the connection and select at least one model first.')
      return
    }
    setBusy(true)
    setStatus('Saving...')
    try {
      const saved = (await window.api.setRemoteVisionServer(
        payload()
      )) as RemoteVisionServerSettings
      applySettings(saved)
      setApiKey('')
      setStatus(saved.activeServerId ? 'Server saved and active.' : 'Local model is active.')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Settings could not be saved.')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (serverId: string): Promise<void> => {
    setBusy(true)
    try {
      const saved = (await window.api.removeRemoteVisionServer(
        serverId
      )) as RemoteVisionServerSettings
      applySettings(saved)
      setStatus('Server removed.')
    } catch {
      setStatus('Server could not be removed.')
    } finally {
      setBusy(false)
    }
  }

  const addServer = (): void => {
    setRemoteEnabled(true)
    setForm(EMPTY_FORM)
    setApiKey('')
    setModels([])
    setModelQuery('')
    setShowModels(false)
    setStatus('Enter the new server details.')
  }

  const activeServer = settings.servers.find((server) => server.id === settings.activeServerId)
  const serversSummary =
    settings.servers.length === 0
      ? 'No saved servers'
      : `${settings.servers.length} saved · ${activeServer ? `${activeServer.name} active` : 'none active'}`
  const modelName = (id: string | undefined): string =>
    (id && catalogModelName(models, id)) || 'none'
  const serverSummary = remoteEnabled
    ? [form.name || 'New server', form.model ? modelName(form.model) : 'no text model'].join(' · ')
    : 'Off: uses models on this device'
  const otherModelsSummary = `Image: ${modelName(form.mediaModels.image)} · Transcription: ${modelName(form.mediaModels.transcription)} · Voice: ${modelName(form.mediaModels.voice)}`

  return (
    <>
      <SettingsSection
        id="remote.servers"
        title="Saved servers"
        summary={serversSummary}
        defaultOpen
      >
        {/* The section header already names the group; one hint line carries the add action. */}
        <div className="flex items-center justify-between gap-3 py-1">
          <p className="min-w-0 text-[11.5px] leading-snug text-neutral-500">
            Save model servers once, then switch between them when you need one.
          </p>
          <IconTip label="Add server">
            <Button
              type="button"
              size="icon-sm"
              variant="outline"
              aria-label="Add server"
              onClick={addServer}
              className="shrink-0 border-neutral-700 text-neutral-300 hover:border-neutral-600 hover:text-white"
            >
              <Plus />
            </Button>
          </IconTip>
        </div>
        {settings.servers.length > 0 ? (
          <div className="divide-y divide-neutral-900">
            <AnimatePresence initial={false}>
              {settings.servers.map((server) => (
                <motion.div
                  key={server.id}
                  layout
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                >
                  <ListRow
                    density="compact"
                    title={server.name}
                    description={`${server.endpoint} · ${server.model}`}
                    onSelect={() => selectServer(server)}
                    selected={form.id === server.id}
                    meta={
                      settings.activeServerId === server.id ? (
                        <Badge variant="success" size="sm">
                          Active
                        </Badge>
                      ) : null
                    }
                    actions={
                      <>
                        <IconTip label="Change model">
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label="Change model"
                            onClick={() => void changeModel(server)}
                            disabled={busy}
                            className="text-neutral-400 hover:text-white disabled:opacity-40"
                          >
                            <PencilSimple />
                          </Button>
                        </IconTip>
                        <IconTip label="Remove">
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            aria-label="Remove"
                            onClick={() => void remove(server.id)}
                            disabled={busy}
                            className="text-neutral-500 hover:text-red-400 disabled:opacity-40"
                          >
                            <Trash />
                          </Button>
                        </IconTip>
                      </>
                    }
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <p className="pb-1 text-[10px] text-neutral-600">No saved servers.</p>
        )}
      </SettingsSection>

      <SettingsSection id="remote.server" title="Server" summary={serverSummary} defaultOpen>
        <div
          role="group"
          aria-label="Remote server details"
          className="grid grid-cols-1 gap-x-3 lg:grid-cols-2"
        >
          <Row
            inline
            label="Use remote server"
            controlId="remote-server-enabled"
            hint="Off uses models on this device."
          >
            <Switch
              id="remote-server-enabled"
              aria-label="Use remote server"
              checked={remoteEnabled}
              onCheckedChange={() => {
                setRemoteEnabled((enabled) => !enabled)
                setStatus('Not saved.')
              }}
            />
          </Row>

          {remoteEnabled ? (
            <>
              <Row label="Server name" controlId="remote-server-name">
                <input
                  id="remote-server-name"
                  value={form.name}
                  onChange={(event) => {
                    setForm((current) => ({ ...current, name: event.target.value }))
                    setStatus('Not saved.')
                  }}
                  placeholder="e.g., Home server"
                  className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus-visible:border-green-500"
                />
              </Row>
              <Row
                label="Address"
                controlId="remote-server-address"
                hint={
                  form.endpoint.trim()
                    ? `Will connect to: ${remoteVisionApiBase(form.endpoint)}/models`
                    : 'Base address. /v1 is added when needed.'
                }
              >
                <input
                  id="remote-server-address"
                  value={form.endpoint}
                  onChange={(event) => {
                    setForm((current) => ({
                      ...current,
                      endpoint: event.target.value,
                      model: '',
                      mediaModels: {},
                      roleModels: {},
                      modelCatalog: [],
                      screenFramesAllowed: false
                    }))
                    setModels([])
                    setModelQuery('')
                    setStatus('Not tested.')
                  }}
                  placeholder="https://models.example"
                  className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus-visible:border-green-500"
                />
              </Row>
              <Row
                label="API key (optional)"
                controlId="remote-server-api-key"
                hint={
                  form.hasApiKey
                    ? 'A key is stored in the system credential store (••••••••).'
                    : 'Optional for servers that do not require a key.'
                }
              >
                <input
                  id="remote-server-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => {
                    setApiKey(event.target.value)
                    setStatus('Not tested.')
                  }}
                  autoComplete="off"
                  placeholder={
                    form.hasApiKey ? 'Stored key - enter a new value to replace it' : 'API key'
                  }
                  className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus-visible:border-green-500"
                />
              </Row>
              {providerNeedsScreenDisclosure(remoteVisionProviderForEndpoint(form.endpoint)) ? (
                <div className="lg:col-span-2">
                  <Row
                    inline
                    label="Allow screen images"
                    controlId="remote-server-screen-frames"
                    hint={
                      form.screenFramesAllowed
                        ? `Allowed after Save. Web Use and Computer Use can send screen images with visible text, apps, and other content to ${form.name || serverNameFromEndpoint(form.endpoint)} at ${serverNameFromEndpoint(form.endpoint)}.`
                        : 'Blocked until you allow it. Web Use and Computer Use can send screen images with visible text, apps, and other content to this server.'
                    }
                  >
                    <Switch
                      id="remote-server-screen-frames"
                      aria-label="Allow screen images"
                      checked={form.screenFramesAllowed}
                      onCheckedChange={() => {
                        setForm((current) => ({
                          ...current,
                          screenFramesAllowed: !current.screenFramesAllowed
                        }))
                        setStatus('Not saved.')
                      }}
                    />
                  </Row>
                </div>
              ) : null}
              <Row
                label="Text + Vision"
                controlId="remote-server-model-search"
                hint={
                  form.model ? `Selected: ${modelName(form.model)}` : 'Search and select one model.'
                }
              >
                <div className="relative">
                  <input
                    id="remote-server-model-search"
                    value={modelQuery}
                    onFocus={() => setShowModels(true)}
                    onChange={(event) => {
                      setModelQuery(event.target.value)
                      setForm((current) => ({
                        ...current,
                        model: '',
                        mediaModels: { ...current.mediaModels, text: undefined }
                      }))
                      setShowModels(true)
                    }}
                    placeholder="Search models"
                    autoComplete="off"
                    className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus-visible:border-green-500"
                  />
                  {showModels ? (
                    <div className="mt-1 max-h-56 overflow-y-auto border border-neutral-800 bg-neutral-950 p-1">
                      {filteredModels.length > 0 ? (
                        filteredModels.map((model) => (
                          <button
                            key={model.id}
                            type="button"
                            onClick={() => {
                              setForm((current) => ({
                                ...current,
                                model: model.id,
                                mediaModels: { ...current.mediaModels, text: model.id }
                              }))
                              setModelQuery(catalogModelName(models, model.id))
                              setShowModels(false)
                              setStatus('Not saved.')
                            }}
                            className="block w-full px-2 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-900 hover:text-white"
                          >
                            <span className="block truncate">
                              {catalogModelName(models, model.id)}
                            </span>
                            {catalogModelName(models, model.id) !== model.id ? (
                              <span className="block truncate text-[9px] text-neutral-600">
                                {model.id}
                              </span>
                            ) : null}
                          </button>
                        ))
                      ) : (
                        <p className="px-2 py-3 text-[10px] text-neutral-600">
                          No matching models.
                        </p>
                      )}
                    </div>
                  ) : null}
                </div>
              </Row>
            </>
          ) : null}
        </div>
      </SettingsSection>

      {remoteEnabled ? (
        <SettingsSection id="remote.models" title="Other models" summary={otherModelsSummary}>
          <div
            role="group"
            aria-label="Other remote models"
            className="grid grid-cols-1 gap-x-3 lg:grid-cols-2"
          >
            {(['grounding', 'decision'] as const).map((role) => (
              <Row
                inline
                key={role}
                label={role === 'grounding' ? 'Grounding specialist' : 'Decision model'}
                controlId={`remote-server-${role}-model`}
                hint="Only this selection appears in Tasks."
              >
                <SettingsSelect
                  id={`remote-server-${role}-model`}
                  label={`${role} model`}
                  value={form.roleModels[role] ?? ''}
                  searchable
                  options={[
                    { value: '', label: `No remote ${role} model` },
                    ...models
                      .filter((model) => {
                        if (model.kind !== 'text') return false
                        const decision = model.outputModalities?.includes('decisions') === true
                        return role === 'decision'
                          ? decision
                          : !decision && isGrounderModel(model.id)
                      })
                      .map((model) => ({ value: model.id, label: model.name }))
                  ]}
                  onValueChange={(value) => {
                    setForm((current) => ({
                      ...current,
                      roleModels: { ...current.roleModels, [role]: value || undefined }
                    }))
                    setStatus('Not saved.')
                  }}
                />
              </Row>
            ))}
            {(['image', 'transcription', 'voice'] as const).map((kind) => (
              <Row
                inline
                key={kind}
                label={kind === 'image' ? 'Image' : kind === 'voice' ? 'Voice' : 'Transcription'}
                controlId={`remote-server-${kind}-model`}
              >
                <SettingsSelect
                  id={`remote-server-${kind}-model`}
                  label={`${kind} model`}
                  value={form.mediaModels[kind] ?? ''}
                  searchable
                  options={[
                    { value: '', label: `No ${kind} model` },
                    ...models
                      .filter((model) => model.kind === kind)
                      .map((model) => ({ value: model.id, label: model.name }))
                  ]}
                  onValueChange={(value) => {
                    setForm((current) => ({
                      ...current,
                      mediaModels: { ...current.mediaModels, [kind]: value || undefined }
                    }))
                    setStatus('Not saved.')
                  }}
                />
              </Row>
            ))}
          </div>
        </SettingsSection>
      ) : null}

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-neutral-800 pt-3">
        <div className="min-w-0 flex-1">
          <LiveStatus className="text-[10px] text-neutral-500">{status}</LiveStatus>
        </div>
        {remoteEnabled ? (
          <button
            type="button"
            onClick={() => void test()}
            disabled={busy}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-600 hover:text-white disabled:opacity-40"
          >
            Test connection
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="rounded-md border border-green-500 px-3 py-1.5 text-xs text-green-500 hover:bg-green-500/10 disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </>
  )
}
