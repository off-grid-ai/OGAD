import { useEffect, useState } from 'react'
import { Button } from '@offgrid/operator-ui/operator/button'
import {
  Field,
  FieldDescription,
  FieldError,
  Input,
  Label,
  NativeSelect
} from '@offgrid/operator-ui/operator/forms'
import type { GatewayApiKeySettingsContract } from '../../../shared/ipc-contracts'

export function GatewayApiKeysSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<GatewayApiKeySettingsContract | null>(null)
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState('30')
  const [date, setDate] = useState('')
  const [createdKey, setCreatedKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<{
    action: 'revoke' | 'replace' | 'disable'
    id?: string
    name?: string
  } | null>(null)

  useEffect(() => {
    let mounted = true
    window.api
      .gatewayApiKeys()
      .then((value) => {
        if (mounted) setSettings(value)
      })
      .catch(() => {
        if (mounted)
          setError('Could not read API keys. Unlock system key storage and reopen this page.')
      })
    return () => {
      mounted = false
    }
  }, [])

  async function run(work: () => Promise<void>): Promise<void> {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update API keys.')
    } finally {
      setBusy(false)
    }
  }

  async function create(replaceId?: string, previousName?: string): Promise<void> {
    const expiresAt =
      expiry === 'never'
        ? null
        : expiry === 'custom'
          ? new Date(date).getTime()
          : Date.now() + Number(expiry) * 86400000
    const result = await window.api.createGatewayApiKey(previousName ?? name, expiresAt, replaceId)
    setSettings(result.settings)
    setCreatedKey(result.key)
    setName('')
    setConfirm(null)
  }

  if (!settings)
    return error ? <FieldError>{error}</FieldError> : <p role="status">Loading API keys...</p>

  return (
    <div className="space-y-4 text-xs">
      <p className="text-neutral-400">
        Control access to the OpenAI-compatible API. Clients must send the key as an
        Authorization: Bearer header.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <span role="status">{settings.enabled ? 'API key required' : 'API key not required'}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            settings.enabled
              ? setConfirm({ action: 'disable' })
              : void run(async () => {
                  setSettings(await window.api.setGatewayApiKeyRequired(true))
                })
          }
        >
          {settings.enabled ? 'Turn off authentication' : 'Require API keys'}
        </Button>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void run(() => create())
        }}
      >
        <Field className="min-w-0 flex-1">
          <Label htmlFor="gateway-key-name">Key name</Label>
          <Input
            id="gateway-key-name"
            value={name}
            maxLength={80}
            required
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            placeholder="Phone, laptop, or service"
          />
        </Field>
        <Field>
          <Label htmlFor="gateway-key-expiry">Expiry</Label>
          <NativeSelect
            id="gateway-key-expiry"
            value={expiry}
            disabled={busy}
            onChange={(e) => setExpiry(e.target.value)}
          >
            <option value="7">7 days</option>
            <option value="30">30 days</option>
            <option value="90">90 days</option>
            <option value="custom">Custom date and time</option>
            <option value="never">No expiry</option>
          </NativeSelect>
        </Field>
        {expiry === 'custom' && (
          <Field>
            <Label htmlFor="gateway-key-date">Expires at (local time)</Label>
            <Input
              id="gateway-key-date"
              type="datetime-local"
              required
              value={date}
              disabled={busy}
              onChange={(e) => setDate(e.target.value)}
            />
          </Field>
        )}
        <Button size="sm" type="submit" disabled={busy || !name.trim() || !!createdKey}>
          Create key
        </Button>
      </form>
      <FieldDescription>
        Creating a key turns authentication on. Keys allow all model API operations. Local-only
        settings still require a local connection. MCP and paired browser connections keep their
        separate credentials.
      </FieldDescription>
      {createdKey && (
        <section className="space-y-2 rounded-md border border-neutral-800 p-3">
          <Label htmlFor="gateway-new-key">Copy this key now. It will not be shown again.</Label>
          <Input
            id="gateway-new-key"
            readOnly
            value={createdKey}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void run(async () => {
                  await navigator.clipboard.writeText(createdKey)
                  setNotice('Key copied.')
                })
              }
            >
              Copy key
            </Button>
            <Button size="sm" variant="outline" onClick={() => setCreatedKey('')}>
              Done
            </Button>
          </div>
        </section>
      )}
      {confirm && (
        <section
          className="space-y-2 rounded-md border border-neutral-800 p-3"
          aria-label="Confirm API key change"
        >
          <p>
            {confirm.action === 'disable'
              ? 'Allow model API requests without a key?'
              : confirm.action === 'replace'
                ? `Replace ${confirm.name}? The old key will stop working. The new key uses the expiry selected above.`
                : `Revoke ${confirm.name}? Requests with this key will be rejected.`}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy || (confirm.action === 'replace' && !!createdKey)}
              onClick={() =>
                void run(async () => {
                  if (confirm.action === 'disable')
                    setSettings(await window.api.setGatewayApiKeyRequired(false))
                  else if (confirm.action === 'revoke')
                    setSettings(await window.api.revokeGatewayApiKey(confirm.id!))
                  else await create(confirm.id, confirm.name)
                  setConfirm(null)
                })
              }
            >
              Confirm
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </section>
      )}
      {error && <FieldError>{error}</FieldError>}
      {notice && <p role="status">{notice}</p>}
      {!settings.keys.length && (
        <p className="text-neutral-500">No API keys. Create a separate key for each client.</p>
      )}
      <ul className="space-y-2" aria-label="API keys">
        {settings.keys.map((key) => {
          const status =
            key.revokedAt !== null
              ? 'Revoked'
              : key.expiresAt !== null && key.expiresAt <= Date.now()
                ? 'Expired'
                : 'Active'
          return (
            <li
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 py-3"
            >
              <div className="min-w-0">
                <p className="break-words">
                  {key.name} · {status}
                </p>
                <p className="text-neutral-500">
                  {key.prefix}… · Created {new Date(key.createdAt).toLocaleString()}
                </p>
                <p className="text-neutral-500">
                  {key.expiresAt === null
                    ? 'No expiry'
                    : `Expires ${new Date(key.expiresAt).toLocaleString()}`}{' '}
                  ·{' '}
                  {key.lastUsedAt === null
                    ? 'Never used'
                    : `Last used ${new Date(key.lastUsedAt).toLocaleString()}`}
                </p>
              </div>
              {key.revokedAt === null && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !!createdKey}
                    onClick={() => setConfirm({ action: 'replace', id: key.id, name: key.name })}
                  >
                    Replace {key.name}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setConfirm({ action: 'revoke', id: key.id, name: key.name })}
                  >
                    Revoke {key.name}
                  </Button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            setSettings(await window.api.gatewayApiKeys())
          })
        }
      >
        Refresh status
      </Button>
    </div>
  )
}
