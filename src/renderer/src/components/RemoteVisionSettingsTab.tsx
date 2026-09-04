import { useEffect, useMemo, useState } from 'react'
import {
  displayRemoteModelName,
  type RemoteModelCatalog,
  type RemoteModelModality,
  type RemoteModalitySelections
} from '@offgrid/application'
import {
  remoteVisionApiBase,
  remoteVisionProviderForEndpoint,
  type RemoteVisionConnectionResult,
  type RemoteVisionSavedServer,
  type RemoteVisionServerSettings,
  type RemoteVisionServerUpdate
} from '../../../shared/remote-vision-server'
import { providerNeedsScreenDisclosure } from '../../../shared/remote-screen-privacy'
import { SettingsRow as Row } from './SettingsRow'

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
  hasApiKey: boolean
  screenFramesAllowed: boolean
  selections: RemoteModalitySelections
  catalog: RemoteModelCatalog
}

const EMPTY_FORM: ServerForm = {
  id: null,
  name: '',
  endpoint: '',
  model: '',
  hasApiKey: false,
  screenFramesAllowed: false,
  selections: {},
  catalog: {}
}

interface RemoteModelOption {
  id: string
  name: string
  modality: RemoteModelModality
}

const MEDIA_MODALITIES: readonly RemoteModelModality[] = [
  'image',
  'transcription',
  'voice',
  'embedding'
]

const MODALITY_LABEL: Readonly<Record<RemoteModelModality, string>> = {
  text: 'Text and vision',
  image: 'Image',
  transcription: 'Transcription',
  voice: 'Voice',
  embedding: 'Embeddings'
}

function formFromServer(server: RemoteVisionSavedServer): ServerForm {
  return {
    id: server.id,
    name: server.name,
    endpoint: server.endpoint,
    model: server.model,
    hasApiKey: server.hasApiKey,
    screenFramesAllowed: server.screenFramesAllowed,
    selections: server.selections ?? (server.model ? { text: server.model } : {}),
    catalog: server.catalog ?? {}
  }
}

/** A server saved without a name is called by its host (main applies the same default). */
function serverNameFromEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return 'Remote server'
  }
}

export function RemoteVisionSettingsTab(): React.JSX.Element {
  const [settings, setSettings] = useState(EMPTY_SETTINGS)
  const [form, setForm] = useState<ServerForm>(EMPTY_FORM)
  const [remoteEnabled, setRemoteEnabled] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState<RemoteModelOption[]>([])
  const [modelQuery, setModelQuery] = useState('')
  const [showModels, setShowModels] = useState(false)
  const [status, setStatus] = useState('Checking saved settings')
  const [busy, setBusy] = useState(false)

  const selectServer = (server: RemoteVisionSavedServer): void => {
    setForm(formFromServer(server))
    setApiKey('')
    setModels(
      Object.entries(server.catalog ?? {}).flatMap(([modality, options]) =>
        options.map((model) => ({
          id: model.id,
          name: model.name,
          modality: modality as RemoteModelModality
        }))
      )
    )
    setModelQuery(server.model)
    setShowModels(false)
    setStatus(server.id === settings.activeServerId ? 'This server is active.' : 'Ready to edit.')
  }

  // Main returns the version 4 shape (a server list with a derived active id); the legacy singleton
  // is migrated there by the shared migration, so nothing is reshaped here.
  const applySettings = (normalized: RemoteVisionServerSettings): void => {
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
      .then((normalized: RemoteVisionServerSettings) => {
        setSettings(normalized)
        setRemoteEnabled(normalized.activeServerId !== null)
        const selected =
          normalized.servers.find((server) => server.id === normalized.activeServerId) ??
          normalized.servers[0]
        if (selected) {
          setForm(formFromServer(selected))
          setModels(
            Object.entries(selected.catalog ?? {}).flatMap(([modality, options]) =>
              options.map((model) => ({
                id: model.id,
                name: model.name,
                modality: modality as RemoteModelModality
              }))
            )
          )
          setModelQuery(selected.model)
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
          model.modality === 'text' &&
          (!query || `${model.name} ${model.id}`.toLowerCase().includes(query))
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
      serverId: form.id ?? undefined,
      name: form.name,
      ...(apiKey ? { apiKey } : {}),
      screenFramesAllowed: form.screenFramesAllowed,
      selections: form.selections,
      catalog: form.catalog
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
      const nextSelections = result.selections ?? {}
      const nextModel =
        nextSelections.text ??
        (discovered.some((model) => model.id === selectedModel && model.modality === 'text')
          ? selectedModel
          : '')
      // Text comes from the capability-projected list; image, transcription, voice, and
      // embeddings come from the catalog, which is the only place the server declares them.
      const mediaModels = Object.entries(result.catalog ?? {}).flatMap(([modality, options]) =>
        modality === 'text'
          ? []
          : options.map((model) => ({
              id: model.id,
              name: model.name,
              modality: modality as RemoteModelModality
            }))
      )
      setModels([...discovered.filter((model) => model.modality === 'text'), ...mediaModels])
      setForm((current) => ({
        ...current,
        model: nextModel,
        selections: nextSelections,
        catalog: result.catalog ?? {}
      }))
      setModelQuery(nextModel)
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
    if (remoteEnabled && !Object.values(form.selections).some(Boolean)) {
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

  return (
    <>
      <p className="mb-3 text-[11px] leading-4 text-neutral-500">
        Save model servers once, then switch between them when you need one.
      </p>

      <div className="mb-3 border-b border-neutral-800 pb-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <p className="text-[11px] uppercase tracking-wide text-neutral-400">Saved servers</p>
          <button
            type="button"
            onClick={addServer}
            className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-600 hover:text-white"
          >
            Add server
          </button>
        </div>
        {settings.servers.length > 0 ? (
          <div className="space-y-2">
            {settings.servers.map((server) => (
              <div
                key={server.id}
                className={`flex items-center gap-3 border p-2 ${form.id === server.id ? 'border-green-500/60 bg-green-500/5' : 'border-neutral-800 bg-neutral-950/40'}`}
              >
                <button
                  type="button"
                  onClick={() => selectServer(server)}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate text-xs text-neutral-200">{server.name}</span>
                  <span className="block truncate text-[10px] text-neutral-600">
                    {server.endpoint} ·{' '}
                    {Object.values(server.selections ?? {}).filter(Boolean).length} selected
                  </span>
                </button>
                {settings.activeServerId === server.id ? (
                  <span className="text-[9px] uppercase tracking-wide text-green-500">Active</span>
                ) : null}
                <button
                  type="button"
                  onClick={() => void changeModel(server)}
                  disabled={busy}
                  className="text-[10px] text-neutral-400 hover:text-white disabled:opacity-40"
                >
                  Change model
                </button>
                <button
                  type="button"
                  onClick={() => void remove(server.id)}
                  disabled={busy}
                  className="text-[10px] text-neutral-600 hover:text-red-400 disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-neutral-600">No saved servers.</p>
        )}
      </div>

      <div
        role="group"
        aria-label="Remote server details"
        className="grid grid-cols-1 gap-x-3 lg:grid-cols-2 [&>div]:mb-2"
      >
        <Row
          label="Use remote server"
          controlId="remote-server-enabled"
          hint="Off uses models on this device."
        >
          <button
            id="remote-server-enabled"
            type="button"
            role="switch"
            aria-checked={remoteEnabled}
            onClick={() => {
              setRemoteEnabled((enabled) => !enabled)
              setStatus('Not saved.')
            }}
            className={`relative h-6 w-11 rounded-full border transition-colors ${remoteEnabled ? 'border-green-500 bg-green-500/20' : 'border-neutral-700 bg-neutral-900'}`}
          >
            <span
              className={`absolute left-1 top-1 h-3.5 w-3.5 rounded-full transition-transform ${remoteEnabled ? 'translate-x-5 bg-green-500' : 'translate-x-0 bg-neutral-500'}`}
            />
          </button>
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
                    screenFramesAllowed: false,
                    selections: {},
                    catalog: {}
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
                  ? 'A key is stored in the system credential store.'
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
                  form.hasApiKey ? '••••••••••••••••  stored key, type to replace' : 'API key'
                }
                className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-200 outline-none placeholder:text-neutral-600 focus-visible:border-green-500"
              />
            </Row>
            {providerNeedsScreenDisclosure(remoteVisionProviderForEndpoint(form.endpoint)) ? (
              <div className="lg:col-span-2 [&>div]:mb-0">
                <Row
                  label="Allow screen images"
                  controlId="remote-server-screen-frames"
                  hint={
                    form.screenFramesAllowed
                      ? `Allowed after Save. Web Use and Computer Use can send screen images with visible text, apps, and other content to ${form.name || serverNameFromEndpoint(form.endpoint)} at ${serverNameFromEndpoint(form.endpoint)}.`
                      : 'Blocked until you allow it. Web Use and Computer Use can send screen images with visible text, apps, and other content to this server.'
                  }
                >
                  <button
                    id="remote-server-screen-frames"
                    type="button"
                    role="switch"
                    aria-checked={form.screenFramesAllowed}
                    onClick={() => {
                      setForm((current) => ({
                        ...current,
                        screenFramesAllowed: !current.screenFramesAllowed
                      }))
                      setStatus('Not saved.')
                    }}
                    className={`relative h-6 w-11 rounded-full border transition-colors ${form.screenFramesAllowed ? 'border-green-500 bg-green-500/20' : 'border-neutral-700 bg-neutral-900'}`}
                  >
                    <span
                      className={`absolute left-1 top-1 h-3.5 w-3.5 rounded-full transition-transform ${form.screenFramesAllowed ? 'translate-x-5 bg-green-500' : 'translate-x-0 bg-neutral-500'}`}
                    />
                  </button>
                </Row>
              </div>
            ) : null}
            {models.some((model) => model.modality === 'text') ? (
              <Row
                label={MODALITY_LABEL.text}
                controlId="remote-server-model-search"
                hint={form.model ? `Selected: ${form.model}` : 'Search and select one model.'}
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
                        selections: { ...current.selections, text: undefined }
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
                                selections: { ...current.selections, text: model.id }
                              }))
                              setModelQuery(displayRemoteModelName(model.name || model.id))
                              setShowModels(false)
                              setStatus('Not saved.')
                            }}
                            className="block w-full px-2 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-900 hover:text-white"
                          >
                            <span className="block truncate">
                              {displayRemoteModelName(model.name || model.id)}
                            </span>
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
            ) : null}
            {MEDIA_MODALITIES.map((modality) => {
              const options = models.filter((model) => model.modality === modality)
              // Image, transcription, and voice are always on offer, so an absence reads as the
              // server's, not the app's. Embeddings stay quiet until a server has one.
              if (!options.length && modality === 'embedding') return null
              if (!options.length) {
                return (
                  <Row
                    key={modality}
                    label={MODALITY_LABEL[modality]}
                    controlId={`remote-server-model-${modality}`}
                    hint={`This server lists no ${MODALITY_LABEL[modality].toLowerCase()} models.`}
                  >
                    <select
                      id={`remote-server-model-${modality}`}
                      value=""
                      disabled
                      className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-500 outline-none"
                    >
                      <option value="">No {MODALITY_LABEL[modality].toLowerCase()} models on this server</option>
                    </select>
                  </Row>
                )
              }
              return (
                <Row
                  key={modality}
                  label={MODALITY_LABEL[modality]}
                  controlId={`remote-server-model-${modality}`}
                  hint={`Choose the ${MODALITY_LABEL[modality].toLowerCase()} model used on this server.`}
                >
                  <select
                    id={`remote-server-model-${modality}`}
                    value={form.selections[modality] ?? ''}
                    onChange={(event) => {
                      const selection = event.target.value
                      setForm((current) => ({
                        ...current,
                        selections: { ...current.selections, [modality]: selection || undefined }
                      }))
                      setStatus('Not saved.')
                    }}
                    className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs text-neutral-200 outline-none focus-visible:border-green-500"
                  >
                    <option value="">Do not use this modality</option>
                    {options.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </Row>
              )
            })}
          </>
        ) : null}
      </div>

      <div className="mt-3 flex items-center justify-between gap-3 border-t border-neutral-800 pt-3">
        <p role="status" aria-live="polite" className="min-w-0 flex-1 text-[10px] text-neutral-500">
          {status}
        </p>
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
