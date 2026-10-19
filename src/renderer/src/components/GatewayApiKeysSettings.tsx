import { useEffect, useState } from 'react'
import { ArrowsClockwise, Check, Copy, Prohibit, Swap, X } from '@phosphor-icons/react'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { Field } from '@offgrid/operator-ui/operator/coss/field'
import { Alert } from '@offgrid/operator-ui/operator/coss/alert'
import { Input } from '@offgrid/operator-ui/operator/coss/input'
import { Label } from '@offgrid/operator-ui/operator/coss/label'
import { Switch } from '@offgrid/operator-ui/operator/coss/switch'
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle
} from '@offgrid/operator-ui/operator/animate/alert-dialog'
import type { GatewayApiKeySettingsContract } from '../../../shared/ipc-contracts'
import { AnimatePresence, motion } from 'motion/react'
import { TextMorph } from '@offgrid/operator-ui/operator/motion/text-morph'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import { SettingsSelect } from './SettingsSelect'
import { GlyphSwap, IconTip } from './IconTip'
import { ListRow } from '@offgrid/operator-ui/operator/list-row'
import { LiveStatus } from '@offgrid/operator-ui/operator/presence'

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
      .catch((reason: unknown) => {
        if (mounted)
          setError(
            reason instanceof Error && reason.message.includes('API key storage is locked')
              ? 'API key storage is locked. Unlock system key storage and reopen this page.'
              : 'Could not read API keys. Unlock system key storage and reopen this page.'
          )
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
    return error ? (
      <Alert className="py-2 text-xs">{error}</Alert>
    ) : (
      <p role="status">
        <TextShimmer as="span">Loading API keys...</TextShimmer>
      </p>
    )

  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between gap-3">
        {/* One control for one setting: the switch is the state and the way to change it. A pill
          beside a larger "Turn off authentication" button said the same thing twice. */}
        <label className="flex w-fit cursor-pointer items-center gap-2.5">
          <Switch
            checked={settings.enabled}
            disabled={busy}
            aria-label="Require an API key"
            onCheckedChange={(checked: boolean) =>
              checked
                ? void run(async () => {
                    setSettings(await window.api.setGatewayApiKeyRequired(true))
                  })
                : setConfirm({ action: 'disable' })
            }
          />
          <span role="status" className="text-xs text-neutral-300">
            <TextMorph as="span">
              {settings.enabled ? 'API key required' : 'API key not required'}
            </TextMorph>
          </span>
        </label>
        <IconTip label="Refresh status">
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Refresh status"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setSettings(await window.api.gatewayApiKeys())
              })
            }
          >
            <ArrowsClockwise />
          </Button>
        </IconTip>
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void run(() => create())
        }}
      >
        {/* One row: the placeholder and the select say what they are, so no labels float above
            them (each keeps its accessible name). */}
        <Field className="min-w-0 flex-1">
          <Input
            id="gateway-key-name"
            aria-label="Key name"
            value={name}
            maxLength={80}
            required
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            placeholder="New key name: phone, laptop, or service"
          />
        </Field>
        <Field>
          <SettingsSelect
            id="gateway-key-expiry"
            label="Expiry"
            value={expiry}
            disabled={busy}
            onValueChange={setExpiry}
            options={[
              { value: '7', label: '7 days' },
              { value: '30', label: '30 days' },
              { value: '90', label: '90 days' },
              { value: 'custom', label: 'Custom date and time' },
              { value: 'never', label: 'No expiry' }
            ]}
          />
        </Field>
        {expiry === 'custom' && (
          <Field>
            <Input
              id="gateway-key-date"
              aria-label="Expires at (local time)"
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
      <p className="text-[11px] text-neutral-500">
        Clients send the key as a Bearer token. Use one key per client.
      </p>
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
            <IconTip label="Copy key">
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="Copy key"
                onClick={() =>
                  void run(async () => {
                    await navigator.clipboard.writeText(createdKey)
                    setNotice('Key copied.')
                  })
                }
              >
                <GlyphSwap glyphKey={notice === 'Key copied.' ? 'copied' : 'copy'}>
                  {notice === 'Key copied.' ? <Check className="text-emerald-400" /> : <Copy />}
                </GlyphSwap>
              </Button>
            </IconTip>
            <IconTip label="Done">
              <Button
                size="icon-sm"
                variant="outline"
                aria-label="Done"
                onClick={() => setCreatedKey('')}
              >
                <X />
              </Button>
            </IconTip>
          </div>
        </section>
      )}
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogPopup className="sm:max-w-md" aria-label="Confirm API key change">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-[17px] font-normal">
              {confirm?.action === 'disable'
                ? 'Turn off authentication?'
                : confirm?.action === 'replace'
                  ? `Replace ${confirm.name}?`
                  : `Revoke ${confirm?.name ?? 'this key'}?`}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-[13px]">
              {confirm?.action === 'disable'
                ? 'Allow model API requests without a key?'
                : confirm?.action === 'replace'
                  ? `Replace ${confirm.name}? The old key will stop working. The new key uses the expiry selected above.`
                  : `Revoke ${confirm?.name}? Requests with this key will be rejected.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button size="sm" variant="ghost" />}>
              Cancel
            </AlertDialogClose>
            <Button
              size="sm"
              variant={confirm?.action === 'replace' ? 'default' : 'destructive'}
              loading={busy}
              disabled={busy || (confirm?.action === 'replace' && !!createdKey)}
              onClick={() => {
                if (!confirm) return
                void run(async () => {
                  if (confirm.action === 'disable')
                    setSettings(await window.api.setGatewayApiKeyRequired(false))
                  else if (confirm.action === 'revoke')
                    setSettings(await window.api.revokeGatewayApiKey(confirm.id!))
                  else await create(confirm.id, confirm.name)
                  setConfirm(null)
                })
              }}
            >
              Confirm
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {error && <Alert className="py-2 text-xs">{error}</Alert>}
      {notice && <LiveStatus travel="across">{notice}</LiveStatus>}
      {!settings.keys.length && (
        <p className="text-neutral-500">No API keys. Create a separate key for each client.</p>
      )}
      <ul className="divide-y divide-neutral-900" aria-label="API keys">
        <AnimatePresence initial={false}>
          {settings.keys.map((key) => {
            const status =
              key.revokedAt !== null
                ? 'Revoked'
                : key.expiresAt !== null && key.expiresAt <= Date.now()
                  ? 'Expired'
                  : 'Active'
            return (
              <motion.li
                key={key.id}
                layout
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              >
                <ListRow
                  title={`${key.name} · ${status}`}
                  description={`${key.prefix}… · Created ${new Date(key.createdAt).toLocaleString()} · ${
                    key.lastUsedAt === null
                      ? 'Never used'
                      : `Last used ${new Date(key.lastUsedAt).toLocaleString()}`
                  }`}
                  meta={
                    key.expiresAt === null
                      ? 'No expiry'
                      : `Expires ${new Date(key.expiresAt).toLocaleString()}`
                  }
                  actions={
                    key.revokedAt === null ? (
                      <>
                        <IconTip label={`Replace ${key.name}`}>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Replace ${key.name}`}
                            disabled={busy || !!createdKey}
                            onClick={() =>
                              setConfirm({ action: 'replace', id: key.id, name: key.name })
                            }
                          >
                            <Swap />
                          </Button>
                        </IconTip>
                        <IconTip label={`Revoke ${key.name}`}>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Revoke ${key.name}`}
                            className="hover:text-red-400"
                            disabled={busy}
                            onClick={() =>
                              setConfirm({ action: 'revoke', id: key.id, name: key.name })
                            }
                          >
                            <Prohibit />
                          </Button>
                        </IconTip>
                      </>
                    ) : undefined
                  }
                />
              </motion.li>
            )
          })}
        </AnimatePresence>
      </ul>
    </div>
  )
}
