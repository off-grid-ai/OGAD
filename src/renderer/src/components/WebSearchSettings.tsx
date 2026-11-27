import { useEffect, useState } from 'react'
import { CheckCircle, Lock, WarningCircle } from '@phosphor-icons/react'
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  WEB_SEARCH_COPY,
  WEB_SEARCH_PROVIDERS,
  normalizeSearxngUrl,
  webSearchNeeds,
  type WebSearchProviderId,
  type WebSearchSettings as Settings,
  type WebSearchTestResult
} from '@offgrid/models'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { Input } from '@offgrid/operator-ui/operator/coss/input'
import { SettingsSection } from './SettingsSection'

type Check = { state: 'idle' } | { state: 'testing' } | { state: 'done'; result: WebSearchTestResult }

/**
 * Settings → Tools → Web search: where web_search sends a model's searches. Built in (free), the
 * person's SearXNG server, or their own Brave Search or Tavily key. A pick saves at once; Test saves
 * what was typed and asks only that provider. The key goes to main's secret store and never comes back.
 */
export function WebSearchSettings(): React.JSX.Element {
  const [settings, setSettings] = useState<Settings>(DEFAULT_WEB_SEARCH_SETTINGS)
  const [keys, setKeys] = useState<Record<string, boolean>>({})
  const [address, setAddress] = useState('')
  const [keyDraft, setKeyDraft] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [check, setCheck] = useState<Check>({ state: 'idle' })

  useEffect(() => {
    let live = true
    // A preload without web search (an older build, or a screen's test) keeps the built-in default.
    void (window.api as Partial<typeof window.api>).webSearchState?.().then((state) => {
      if (!live || !state) return
      setSettings(state.settings)
      setKeys(state.keys)
      setAddress(state.settings.searxngUrl ?? '')
    })
    return () => {
      live = false
    }
  }, [])

  const provider = settings.provider
  const needs = webSearchNeeds(provider)
  const hasKey = Boolean(keys[provider])
  const label = WEB_SEARCH_PROVIDERS.find((p) => p.id === provider)?.label

  const save = (next: Settings): void => {
    setSettings(next)
    void window.api.webSearchSave(next)
  }

  const choose = (id: WebSearchProviderId): void => {
    save({ ...settings, provider: id })
    setCheck({ state: 'idle' })
    setKeyDraft('')
    setReplacing(false)
  }

  const saveAddress = (): Settings => {
    const url = normalizeSearxngUrl(address)
    setAddress(url)
    const next = { ...settings, searxngUrl: url }
    if (url !== (settings.searxngUrl ?? '')) save(next)
    return next
  }

  const runTest = async (): Promise<void> => {
    setCheck({ state: 'testing' })
    try {
      const next = needs === 'address' ? saveAddress() : settings
      const typed = keyDraft.trim()
      if (needs === 'key' && typed) {
        if (await window.api.webSearchSetKey(provider, typed)) {
          setKeys((k) => ({ ...k, [provider]: true }))
          setKeyDraft('')
          setReplacing(false)
        }
      }
      setCheck({ state: 'done', result: await window.api.webSearchTest(next) })
    } catch (error) {
      setCheck({
        state: 'done',
        result: { ok: false, reason: error instanceof Error ? error.message : String(error) }
      })
    }
  }

  const removeKey = async (): Promise<void> => {
    await window.api.webSearchRemoveKey(provider)
    setKeys((k) => ({ ...k, [provider]: false }))
    setCheck({ state: 'idle' })
  }

  return (
    <SettingsSection id="web-search" title={WEB_SEARCH_COPY.title} summary={label} defaultOpen>
      <p className="mb-3 text-xs text-neutral-500">{WEB_SEARCH_COPY.intro}</p>
      <div
        role="radiogroup"
        aria-label={WEB_SEARCH_COPY.title}
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
      >
        {WEB_SEARCH_PROVIDERS.map((p) => {
          const chosen = p.id === provider
          return (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={chosen}
              data-testid={`web-search-provider-${p.id}`}
              onClick={() => choose(p.id)}
              className={`flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[0.99] ${
                chosen
                  ? 'border-green-500/60 bg-green-500/5'
                  : 'border-neutral-800 hover:border-neutral-600'
              }`}
            >
              <span className="min-w-0">
                <span className="block text-sm text-neutral-200">{p.label}</span>
                <span className="block text-xs text-neutral-500">{p.detail}</span>
              </span>
              {chosen && <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-green-500" aria-hidden />}
            </button>
          )
        })}
      </div>

      {needs === 'address' && (
        <label className="mt-3 block">
          <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-neutral-500">
            {WEB_SEARCH_COPY.addressLabel}
          </span>
          <Input
            size="sm"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onBlur={saveAddress}
            placeholder={WEB_SEARCH_COPY.addressPlaceholder}
            spellCheck={false}
            aria-label={WEB_SEARCH_COPY.addressLabel}
            data-testid="web-search-address"
          />
        </label>
      )}

      {needs === 'key' &&
        (hasKey && !replacing ? (
          <div
            className="mt-3 flex items-center gap-2 rounded-md border border-neutral-800 px-3 py-2"
            data-testid="web-search-key-saved"
          >
            <Lock size={14} className="shrink-0 text-neutral-400" aria-hidden />
            <span className="flex-1 text-sm text-neutral-300">{WEB_SEARCH_COPY.keySaved}</span>
            <Button size="sm" variant="ghost" onClick={() => setReplacing(true)}>
              {WEB_SEARCH_COPY.replaceKey}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void removeKey()}>
              {WEB_SEARCH_COPY.removeKey}
            </Button>
          </div>
        ) : (
          <label className="mt-3 block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-wide text-neutral-500">
              {WEB_SEARCH_COPY.keyLabel}
            </span>
            <Input
              size="sm"
              type="password"
              value={keyDraft}
              onChange={(e) => setKeyDraft(e.target.value)}
              placeholder={WEB_SEARCH_COPY.keyPlaceholder}
              autoComplete="off"
              aria-label={WEB_SEARCH_COPY.keyLabel}
              data-testid="web-search-key"
            />
          </label>
        ))}

      <div className="mt-3 flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          disabled={check.state === 'testing'}
          aria-busy={check.state === 'testing'}
          onClick={() => void runTest()}
          data-testid="web-search-test"
        >
          {check.state === 'testing' ? WEB_SEARCH_COPY.testing : WEB_SEARCH_COPY.test}
        </Button>
        {check.state === 'done' && (
          <span
            role="status"
            data-testid="web-search-result"
            className="flex min-w-0 items-center gap-1.5 text-xs"
          >
            {check.result.ok ? (
              <CheckCircle size={14} weight="fill" className="shrink-0 text-green-500" aria-hidden />
            ) : (
              <WarningCircle size={14} className="shrink-0 text-red-400" aria-hidden />
            )}
            <span className="text-neutral-200">
              {check.result.ok ? WEB_SEARCH_COPY.works : WEB_SEARCH_COPY.failed}
            </span>
            {!check.result.ok && <span className="truncate text-neutral-500">{check.result.reason}</span>}
          </span>
        )}
      </div>
      <p className="mt-2 text-xs text-neutral-500">{WEB_SEARCH_COPY.fallback}</p>
    </SettingsSection>
  )
}
