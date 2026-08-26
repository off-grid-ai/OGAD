import { useEffect, useMemo, useState } from 'react'
import {
  remoteVisionApiBase,
  remoteVisionProviderForEndpoint,
  type RemoteVisionConnectionResult,
  type RemoteVisionSavedServer,
  type RemoteVisionServerSettings,
  type RemoteVisionServerUpdate
} from '../../../shared/remote-vision-server'
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
}

const EMPTY_FORM: ServerForm = { id: null, name: '', endpoint: '', model: '', hasApiKey: false }

interface RemoteModelOption {
  id: string
  name: string
}

function formFromServer(server: RemoteVisionSavedServer): ServerForm {
  return {
    id: server.id,
    name: server.name,
    endpoint: server.endpoint,
    model: server.model,
    hasApiKey: server.hasApiKey
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
          hasApiKey: value.hasApiKey
        }
      : null
  return {
    ...value,
    activeServerId: legacyServer?.id ?? null,
    servers: legacyServer ? [legacyServer] : []
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
    setModels(server.model ? [{ id: server.model, name: server.model }] : [])
    setModelQuery(server.model)
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
          setModels(selected.model ? [{ id: selected.model, name: selected.model }] : [])
          setModelQuery(selected.model)
        }
        setStatus(normalized.activeServerId ? 'Remote server is active.' : 'Local model is active.')
      })
      .catch(() => setStatus('Remote server settings could not be read.'))
  }, [])

  const filteredModels = useMemo(() => {
    const query = modelQuery.trim().toLowerCase()
    return models
      .filter((model) => !query || `${model.name} ${model.id}`.toLowerCase().includes(query))
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
      ...(apiKey ? { apiKey } : {})
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
      const nextModel = discovered.some((model) => model.id === selectedModel) ? selectedModel : ''
      setModels(discovered)
      setForm((current) => ({ ...current, model: nextModel }))
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
    if (remoteEnabled && !form.model) {
      setStatus('Test the connection and select a model first.')
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
      <p className="mb-5 text-[11px] leading-5 text-neutral-500">
        Save model servers once, then switch between them when you need one.
      </p>

      <div className="mb-5 border-b border-neutral-800 pb-5">
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
                    {server.endpoint} · {server.model}
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

      <Row
        label="Use remote server"
        controlId="remote-server-enabled"
        hint="Turn this off to use models on this device."
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
                : 'Enter the base address. The app adds /v1 when needed.'
            }
          >
            <input
              id="remote-server-address"
              value={form.endpoint}
              onChange={(event) => {
                setForm((current) => ({ ...current, endpoint: event.target.value, model: '' }))
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
                : 'A server on your own network may not need one.'
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
          {models.length > 0 ? (
            <Row
              label="Model"
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
                    setForm((current) => ({ ...current, model: '' }))
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
                            setForm((current) => ({ ...current, model: model.id }))
                            setModelQuery(model.name)
                            setShowModels(false)
                            setStatus('Not saved.')
                          }}
                          className="block w-full px-2 py-1.5 text-left text-xs text-neutral-300 hover:bg-neutral-900 hover:text-white"
                        >
                          <span className="block truncate">{model.name}</span>
                          {model.name !== model.id ? (
                            <span className="block truncate text-[9px] text-neutral-600">
                              {model.id}
                            </span>
                          ) : null}
                        </button>
                      ))
                    ) : (
                      <p className="px-2 py-3 text-[10px] text-neutral-600">No matching models.</p>
                    )}
                  </div>
                ) : null}
              </div>
            </Row>
          ) : null}
        </>
      ) : null}

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-neutral-800 pt-4">
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
