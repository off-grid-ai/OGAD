import { useState } from 'react';
import { IconServer2, IconCopy, IconCheck, IconExternalLink } from '@tabler/icons-react';

// Explains the local OpenAI-compatible gateway with copyable quick-start snippets
// and a link to the interactive playground the gateway serves. Core feature.
const PORT = 7878;
const BASE = `http://127.0.0.1:${PORT}`;

const ENDPOINTS: { label: string; method: string; path: string; note: string }[] = [
  { label: 'Chat (text + vision)', method: 'POST', path: '/v1/chat/completions', note: 'OpenAI-compatible; image_url parts for vision' },
  { label: 'Text → Image', method: 'POST', path: '/v1/images', note: 'also /v1/images/generations · /edits' },
  { label: 'Speech → Text (STT)', method: 'POST', path: '/v1/audio/transcriptions', note: 'multipart: file' },
  { label: 'Text → Speech (TTS)', method: 'POST', path: '/v1/audio/speech', note: '{ input, voice? } → audio/wav' },
  { label: 'Embeddings', method: 'POST', path: '/v1/embeddings', note: 'local all-MiniLM-L6-v2 · 384-dim' },
  { label: 'Models', method: 'GET', path: '/v1/models', note: 'active model per modality' },
];

const SNIPPETS: { id: string; label: string; code: string }[] = [
  {
    id: 'curl',
    label: 'curl',
    code: `curl ${BASE}/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "local",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'`,
  },
  {
    id: 'python',
    label: 'Python (openai)',
    code: `from openai import OpenAI

client = OpenAI(base_url="${BASE}/v1", api_key="not-needed")
resp = client.chat.completions.create(
    model="local",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)`,
  },
  {
    id: 'node',
    label: 'JavaScript',
    code: `import OpenAI from "openai";

const client = new OpenAI({ baseURL: "${BASE}/v1", apiKey: "not-needed" });
const resp = await client.chat.completions.create({
  model: "local",
  messages: [{ role: "user", content: "Hello!" }],
});
console.log(resp.choices[0].message.content);`,
  },
  {
    id: 'image',
    label: 'Image',
    code: `curl ${BASE}/v1/images \\
  -H "Content-Type: application/json" \\
  -d '{ "prompt": "a misty mountain at dawn", "aspect_ratio": "16:9" }' --output out.png`,
  },
];

function CopyButton({ text }: { text: string }): React.ReactElement {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={() => navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}
      className="flex items-center gap-1.5 rounded-md border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:border-neutral-500 hover:text-white"
    >
      {done ? <IconCheck className="h-3.5 w-3.5 text-green-400" /> : <IconCopy className="h-3.5 w-3.5" />}{done ? 'Copied' : 'Copy'}
    </button>
  );
}

export function GatewayScreen(): React.ReactElement {
  const [tab, setTab] = useState(SNIPPETS[0].id);
  const open = (p: string): void => { window.open(BASE + p, '_blank'); };
  const active = SNIPPETS.find((s) => s.id === tab) ?? SNIPPETS[0];

  return (
    <div className="relative h-full overflow-y-auto font-mono">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 p-1 pb-16">
        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-neutral-700 bg-neutral-800">
            <IconServer2 className="h-5 w-5 text-green-400" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">Gateway</h2>
            <p className="text-sm text-neutral-500">One local, OpenAI-compatible API for every model you download — text, vision, image, voice. Runs on your device; nothing leaves it.</p>
          </div>
        </div>

        {/* Base URL */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
          <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">Base URL</div>
          <div className="flex flex-wrap items-center gap-3">
            <code className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-green-400">{BASE}/v1</code>
            <CopyButton text={`${BASE}/v1`} />
            <button onClick={() => open('/docs')} className="flex items-center gap-1.5 rounded-lg border border-neutral-700 px-3 py-2 text-xs text-neutral-300 hover:border-green-500/60 hover:text-white">
              <IconExternalLink className="h-4 w-4" /> Interactive playground
            </button>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-neutral-500">
            Point any OpenAI client here — no API key needed. Run it headless with <code className="text-neutral-300">--server-only</code> to deploy just the gateway.
          </p>
        </div>

        {/* Quick start */}
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/60 p-5">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {SNIPPETS.map((s) => (
              <button
                key={s.id}
                onClick={() => setTab(s.id)}
                className={`rounded-md px-2.5 py-1 text-xs transition-colors ${tab === s.id ? 'bg-green-500/15 text-green-400' : 'text-neutral-400 hover:text-white'}`}
              >
                {s.label}
              </button>
            ))}
            <div className="ml-auto"><CopyButton text={active.code} /></div>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-950 p-4 text-xs leading-relaxed text-neutral-200"><code>{active.code}</code></pre>
        </div>

        {/* Endpoints */}
        <div>
          <div className="mb-2 text-[10px] uppercase tracking-widest text-neutral-500">Endpoints</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {ENDPOINTS.map((e) => (
              <button key={e.path} onClick={() => open(e.path)} className="flex flex-col gap-1 rounded-xl border border-neutral-800 bg-neutral-900/40 p-3 text-left transition-colors hover:border-green-500/40">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] font-medium text-green-400">{e.method}</span>
                  <span className="text-sm text-neutral-200">{e.label}</span>
                </div>
                <code className="text-xs text-neutral-500">{e.path}</code>
                <span className="text-[11px] text-neutral-600">{e.note}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
