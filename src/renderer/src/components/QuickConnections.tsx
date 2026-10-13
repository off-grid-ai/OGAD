import { SidePanel } from './SidePanel'
import { AnimatePresence } from 'motion/react'
import { CONNECTIONS_CHANGED_EVENT } from './useQuickConnection'
import { getRendererIsPro } from '@renderer/bootstrap/entitlementRegistry'
import { useEffect, useState, type JSX } from 'react'
import { CheckCircle, SlidersHorizontal, X } from '@phosphor-icons/react'
import { Button } from './ui/button'
import { Item, ItemGroup, ItemContent, ItemTitle, ItemDescription, ItemActions } from './ui/item'
import notionLogo from '@/assets/logos/notion.svg'
import jiraLogo from '@/assets/logos/jira.svg'
import confluenceLogo from '@/assets/logos/confluence.svg'
import linearLogo from '@/assets/logos/linear.svg'
import { getSlot, SLOTS } from '@renderer/bootstrap/slotRegistry'
import { loadProQuickConnections } from '@renderer/bootstrap/loadProFeaturesRenderer'
import { CONNECTOR_CATALOG } from './connectorCatalog'
import { useQuickConnection, type QuickConnectionEntry } from './useQuickConnection'

import { QUICK_CONNECTION_IDS } from './quickConnectionCatalog'

export function QuickConnections({
  onBusyChange
}: {
  onBusyChange?: (busy: boolean) => void
}): JSX.Element {
  const [, refreshProviders] = useState(0)
  const [providersFailed, setProvidersFailed] = useState(false)
  useEffect(() => {
    let active = true
    if (!getSlot(SLOTS.quickConnectionProviders) && getRendererIsPro()) {
      // Through the Pro loader seam: core screens never import the private package.
      void loadProQuickConnections()
        .then((loaded) => {
          if (active && loaded) refreshProviders((value) => value + 1)
        })
        .catch(() => {
          // A Pro build whose account cards did not load: say so, rather than show nothing.
          if (active) setProvidersFailed(true)
        })
    }
    return () => {
      active = false
    }
  }, [])
  const [manageUrl, setManageUrl] = useState<string | null>(null)
  const [removing, setRemoving] = useState<number | null>(null)
  const [removeError, setRemoveError] = useState('')
  const [providerBusy, setProviderBusy] = useState(false)
  const connection = useQuickConnection()
  const Providers = getRendererIsPro() ? getSlot(SLOTS.quickConnectionProviders) : undefined
  const pending = !!connection.busy || providerBusy
  useEffect(() => {
    onBusyChange?.(pending)
  }, [pending, onBusyChange])

  return (
    <section aria-label="Quick connections" className="space-y-6">
      <div>
        <h2 className="text-lg text-neutral-100">Connect your work</h2>
        <p className="mt-2 text-sm text-neutral-400">
          Bring your accounts and tools into your private workspace. Accounts are read live when you
          ask and nothing from them is copied into memory. Add as many as you use.
        </p>
      </div>
      {providersFailed && (
        <div role="alert" className="flex items-center gap-3 text-xs">
          <p>Google, Microsoft and Obsidian could not load. Open Integrations later to add them.</p>
        </div>
      )}
      {connection.errors.load && (
        <div role="alert" className="flex items-center gap-3 text-xs">
          <p>{connection.errors.load}</p>
          <Button size="sm" variant="outline" onClick={() => void connection.reload()}>
            Retry
          </Button>
        </div>
      )}
      <AnimatePresence>
        {manageUrl && (
          <SidePanel ariaLabel="Connected accounts" onClose={() => setManageUrl(null)}>
            <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-5">
              <h2 className="text-lg">Connected accounts</h2>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Close connected accounts"
                onClick={() => setManageUrl(null)}
              >
                <X className="size-4" />
              </Button>
            </header>
            <div className="space-y-3 px-6 py-5">
              {connection.items
                .filter((account) => account.url === manageUrl)
                .map((account) => (
                  <Item key={account.id} variant="outline">
                    <ItemContent>
                      <ItemTitle>{account.name}</ItemTitle>
                      <ItemDescription>Connection {account.id}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={removing != null}
                        aria-label={`Remove ${account.name} connection ${account.id}`}
                        onClick={() => {
                          setRemoving(account.id)
                          setRemoveError('')
                          void window.api
                            .mcpRemove(account.id)
                            .then(() => connection.reload())
                            .then(() => window.dispatchEvent(new Event(CONNECTIONS_CHANGED_EVENT)))
                            .catch((cause) =>
                              setRemoveError(
                                cause instanceof Error
                                  ? cause.message
                                  : 'Could not remove this connection.'
                              )
                            )
                            .finally(() => setRemoving(null))
                        }}
                      >
                        {removing === account.id ? 'Removing' : 'Remove'}
                      </Button>
                    </ItemActions>
                  </Item>
                ))}
              {removeError && (
                <p role="alert" className="connection-error">
                  {removeError}
                </p>
              )}
              <p className="text-xs text-neutral-400">
                Removing a connection clears its saved access on this device. You can connect it
                again.
              </p>
            </div>
          </SidePanel>
        )}
      </AnimatePresence>
      <div className="grid gap-8 lg:grid-cols-2">
        {Providers && (
          <section aria-label="Accounts and notes" className="min-w-0">
            <h3 className="connection-group-label">Accounts &amp; notes</h3>
            <ItemGroup role="list">
              {/* The registry returns a stable registered component, not a component factory. */}
              {/* eslint-disable-next-line react-hooks/static-components */}
              <Providers disabled={!!connection.busy} onBusyChange={setProviderBusy} />
            </ItemGroup>
          </section>
        )}
        <section aria-label="Work tools" className="min-w-0">
          <h3 className="connection-group-label">Work tools</h3>
          <ItemGroup role="list">
            {QUICK_CONNECTION_IDS.map((id) => {
              const catalog = CONNECTOR_CATALOG.find((item) => item.id === id)
              if (!catalog?.ready || !catalog.url || catalog.auth !== 'oauth') return null
              const entry: QuickConnectionEntry = {
                id,
                name: id === 'jira' ? 'Jira + Confluence' : catalog.name,
                url: catalog.url
              }
              const record = connection.recordFor(entry)
              const accounts = connection.items.filter(
                (item) => item.url === entry.url && item.status === 'ok' && !!item.enabled
              )
              const connected = accounts.length > 0
              const authorizing = connection.busy === id
              const logo = id === 'notion' ? notionLogo : id === 'jira' ? jiraLogo : linearLogo
              return (
                <div key={id}>
                  <Item
                    role="listitem"
                    aria-label={entry.name}
                    variant="outline"
                    className="connection-item flex-wrap rounded-md"
                  >
                    <div className="flex shrink-0 items-center gap-1">
                      <img src={logo} alt="" className="connection-app-logo" />
                      {id === 'jira' && (
                        <img src={confluenceLogo} alt="" className="connection-app-logo" />
                      )}
                    </div>
                    <ItemContent>
                      <ItemTitle>{entry.name}</ItemTitle>
                      <ItemDescription>
                        {id === 'jira' ? 'Issues and shared pages' : catalog.blurb}
                      </ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      {connected ? (
                        <span role="status" className="connection-status">
                          <CheckCircle aria-hidden="true" className="size-4" /> {accounts.length}{' '}
                          connected
                        </span>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-neutral-700 text-neutral-300 hover:border-green-500 hover:text-green-500"
                        aria-busy={authorizing}
                        disabled={connection.loading || pending}
                        onClick={() => void connection.connect({ ...entry, newAccount: connected })}
                      >
                        {authorizing
                          ? 'Connecting'
                          : connected
                            ? 'Add account'
                            : record
                              ? 'Reconnect'
                              : 'Connect'}
                      </Button>
                      {connected && (
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={pending}
                          aria-label={`${entry.name} accounts`}
                          onClick={() => setManageUrl(entry.url)}
                        >
                          <SlidersHorizontal aria-hidden="true" className="size-4" />
                        </Button>
                      )}
                      {authorizing && (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Cancel ${entry.name} sign-in`}
                          onClick={() => void connection.cancel()}
                        >
                          <X aria-hidden="true" className="size-4" />
                        </Button>
                      )}
                    </ItemActions>
                  </Item>
                  {connection.errors[id] && (
                    <p role="alert" className="mt-2 connection-error">
                      {connection.errors[id]}
                    </p>
                  )}
                </div>
              )
            })}
          </ItemGroup>
        </section>
      </div>
    </section>
  )
}
