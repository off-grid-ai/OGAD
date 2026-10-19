import { useEffect, useState } from 'react'
import { UserIcon, UsersIcon } from '@phosphor-icons/react'
import { IconExternalLink, IconServer2 } from '@tabler/icons-react'
import { GATEWAY_HOST, GATEWAY_PORT } from '@offgrid/core/shared/ports'
import { CopyButton } from './ui/CopyButton'
import { GatewayApiKeysSettings } from './GatewayApiKeysSettings'
import { Segmented } from '@offgrid/operator-ui/operator/segmented'
import { AnimatedGroup } from '@offgrid/operator-ui/operator/motion/animated-group'
import { PageHeader, Section } from '@offgrid/operator-ui/operator/experience'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput
} from '@offgrid/operator-ui/operator/coss/input-group'
import { Button } from './ui/button'
import { IconTip } from './IconTip'
import { SettingsSelect } from './SettingsSelect'

// Explains the local OpenAI-compatible gateway with copyable quick-start snippets
// and a link to the interactive playground the gateway serves. Core feature.
const PORT = GATEWAY_PORT
const BASE = `http://${GATEWAY_HOST}:${PORT}`

const ENDPOINTS: { label: string; method: string; path: string; note: string }[] = [
  {
    label: 'Chat (text + vision)',
    method: 'POST',
    path: '/v1/chat/completions',
    note: 'OpenAI-compatible; image_url parts for vision'
  },
  {
    label: 'Text → Image',
    method: 'POST',
    path: '/v1/images',
    note: 'also /v1/images/generations · /edits'
  },
  {
    label: 'Speech → Text (STT)',
    method: 'POST',
    path: '/v1/audio/transcriptions',
    note: 'multipart: file'
  },
  {
    label: 'Text → Speech (TTS)',
    method: 'POST',
    path: '/v1/audio/speech',
    note: '{ input, voice? } → audio/wav'
  },
  {
    label: 'Embeddings',
    method: 'POST',
    path: '/v1/embeddings',
    note: 'local all-MiniLM-L6-v2 · 384-dim'
  },
  { label: 'Models', method: 'GET', path: '/v1/models', note: 'active model per modality' }
]

const SNIPPETS: { id: string; label: string; code: string }[] = [
  {
    id: 'curl',
    label: 'curl',
    code: `curl ${BASE}/v1/chat/completions \\
  -H "Authorization: Bearer $OGAD_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "local",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'`
  },
  {
    id: 'python',
    label: 'Python (openai)',
    code: `from openai import OpenAI

client = OpenAI(base_url="${BASE}/v1", api_key="YOUR_API_KEY")
resp = client.chat.completions.create(
    model="local",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)`
  },
  {
    id: 'node',
    label: 'JavaScript',
    code: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${BASE}/v1", apiKey: "YOUR_API_KEY" });
const resp = await client.chat.completions.create({
  model: "local",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.choices[0].message.content);`
  },
  {
    id: 'image',
    label: 'Image',
    code: `curl ${BASE}/v1/images \\
  -H "Authorization: Bearer $OGAD_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "prompt": "a misty mountain at dawn", "aspect_ratio": "16:9" }' --output out.png`
  }
]

type GatewayMode = 'single' | 'team'

interface GatewaySettings {
  gatewayMode?: GatewayMode
  gatewaySlots?: number
  gatewaySlotsMax?: number
  gatewayClients?: number | null
}

/** Who the gateway serves: one person at full speed, or several clients at once. Team mode's
 *  "at once" is Auto (the memory rule's value) or a number up to that safe maximum. Either change
 *  relaunches the chat engine with the new slot count; it applies to the next request. */
function GatewayModeControl(): React.ReactElement | null {
  const [settings, setSettings] = useState<GatewaySettings | null>(null)
  useEffect(() => {
    let mounted = true
    void window.api.getLlmSettings().then((s: GatewaySettings) => {
      if (mounted) setSettings(s)
    })
    return () => {
      mounted = false
    }
  }, [])
  if (!settings) return null
  const mode = settings.gatewayMode ?? 'single'
  const save = (patch: { gatewayMode?: GatewayMode; gatewayClients?: number | null }): void => {
    const previous = settings
    setSettings({ ...settings, ...patch })
    void window.api
      .setLlmSettings(patch)
      .then((s: GatewaySettings) => setSettings(s))
      .catch(() => setSettings(previous))
  }
  const option = (
    id: GatewayMode,
    label: string,
    tip: string,
    icon: React.ReactNode
  ): { id: GatewayMode; label: string; icon: React.ReactNode } => ({
    id,
    label,
    icon: (
      <IconTip label={tip}>
        <span className="flex items-center gap-1.5">
          {icon}
          {label}
        </span>
      </IconTip>
    )
  })
  const max = Math.max(1, settings.gatewaySlotsMax ?? 1)
  const clients = settings.gatewayClients ?? null
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Segmented
        label="Who uses the gateway"
        size="sm"
        value={mode}
        onValueChange={(next) => save({ gatewayMode: next })}
        options={[
          option(
            'single',
            'Just me',
            'One request at a time, full speed',
            <UserIcon aria-hidden="true" />
          ),
          option(
            'team',
            'Team',
            'Several clients at once; extras wait their turn',
            <UsersIcon aria-hidden="true" />
          )
        ]}
      />
      {mode === 'team' && (
        <div className="w-36">
          <SettingsSelect
            id="gateway-clients"
            label="Requests at once"
            value={clients === null ? 'auto' : String(Math.min(clients, max))}
            onValueChange={(value) =>
              save({ gatewayClients: value === 'auto' ? null : Number(value) })
            }
            options={[
              { value: 'auto', label: `Auto (${max})` },
              ...Array.from({ length: max }, (_, i) => ({
                value: String(i + 1),
                label: `${i + 1} at once`
              }))
            ]}
          />
        </div>
      )}
    </div>
  )
}

export function GatewayScreen(): React.ReactElement {
  const [tab, setTab] = useState(SNIPPETS[0]!.id)
  const open = (p: string): void => {
    window.open(BASE + p, '_blank')
  }
  const active = SNIPPETS.find((s) => s.id === tab) ?? SNIPPETS[0]!

  return (
    <div className="relative h-full overflow-y-auto font-mono">
      <div className="flex w-full flex-col px-8 pt-8 pb-16">
        <PageHeader
          title="Gateway"
          description="One OpenAI-compatible API for every model on this Mac."
          actions={
            <IconTip label="Interactive playground">
              <Button
                variant="outline"
                size="icon-sm"
                aria-label="Interactive playground"
                onClick={() => open('/docs')}
              >
                <IconExternalLink className="h-4 w-4" />
              </Button>
            </IconTip>
          }
        />

        {/* A landscape screen: how to connect on the left, who may connect on the right. */}
        <div className="grid gap-x-10 gap-y-8 xl:grid-cols-2">
          <div className="min-w-0 space-y-8">
            <Section label="Base URL">
              <InputGroup>
                <InputGroupAddon>
                  <IconServer2 aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupInput
                  readOnly
                  aria-label="Gateway base URL"
                  value={`${BASE}/v1`}
                  className="font-mono text-emerald-400"
                />
                <InputGroupAddon align="inline-end">
                  <CopyButton text={`${BASE}/v1`} />
                </InputGroupAddon>
              </InputGroup>
              <p className="mt-2 text-[11px] text-neutral-500">
                Headless: run with <code className="text-neutral-300">--server-only</code>.
              </p>
            </Section>

            <Section label="Quick start" actions={<CopyButton text={active.code} />}>
              <Segmented
                label="Quick start language"
                size="sm"
                tone="quiet"
                value={tab}
                onValueChange={setTab}
                options={SNIPPETS.map((s) => ({ id: s.id, label: s.label }))}
              />
              <pre className="mt-3 overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-xs leading-relaxed text-neutral-200">
                <code>{active.code}</code>
              </pre>
            </Section>
          </div>

          <div className="min-w-0 space-y-8">
            <Section label="Clients">
              <section aria-label="Clients">
                <GatewayModeControl />
              </section>
            </Section>

            <Section label="API keys">
              <section aria-label="API keys">
                <GatewayApiKeysSettings />
              </section>
            </Section>

            <Section label="Endpoints">
              <AnimatedGroup preset="blur-slide" className="grid gap-2 2xl:grid-cols-2">
                {ENDPOINTS.map((e) => (
                  <button
                    key={e.path}
                    onClick={() => open(e.path)}
                    title={e.note}
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-left transition-colors hover:border-green-500/40"
                  >
                    <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-emerald-400">
                      {e.method}
                    </span>
                    <span className="shrink-0 text-xs text-neutral-200">{e.label}</span>
                    <code className="min-w-0 truncate text-[11px] text-neutral-500">{e.path}</code>
                  </button>
                ))}
              </AnimatedGroup>
            </Section>
          </div>
        </div>
      </div>
    </div>
  )
}
