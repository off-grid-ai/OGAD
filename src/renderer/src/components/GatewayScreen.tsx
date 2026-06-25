import { useState } from 'react';
import { IconServer2, IconCopy, IconCheck, IconExternalLink } from '@tabler/icons-react';

// Explains the local OpenAI-compatible gateway and embeds its interactive docs
// (the gateway serves a Scalar API reference at /docs). Core feature.
const PORT = 7878;
const BASE = `http://127.0.0.1:${PORT}`;

const ENDPOINTS: { label: string; method: string; path: string; note: string }[] = [
  { label: 'Chat (text + vision)', method: 'POST', path: '/v1/chat/completions', note: 'OpenAI-compatible; image_url parts for vision' },
  { label: 'Text → Image', method: 'POST', path: '/v1/images', note: 'also /v1/images/generations · /v1/images/edits' },
  { label: 'Speech → Text (STT)', method: 'POST', path: '/v1/audio/transcriptions', note: 'multipart: file' },
  { label: 'Text → Speech (TTS)', method: 'POST', path: '/v1/audio/speech', note: '{ input, voice? } → audio/wav' },
  { label: 'Embeddings', method: 'POST', path: '/v1/embeddings', note: 'local all-MiniLM-L6-v2 · 384-dim' },
  { label: 'Models', method: 'GET', path: '/v1/models', note: 'active model per modality' },
];

export function GatewayScreen(): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copyBase = (): void => {
    navigator.clipboard.writeText(BASE).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
  };
  const open = (p: string): void => { window.open(BASE + p, '_blank'); };

  return (
    <div className="relative h-full overflow-y-auto font-mono">
      <div className="mx-auto flex max-w-5xl flex-col gap-6 p-1">
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
          <div className="flex items-center gap-3">
            <code className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-green-400">{BASE}</code>
            <button onClick={copyBase} className="flex items-center gap-1.5 rounded-lg border border-neutral-700 px-3 py-2 text-xs text-neutral-300 hover:border-neutral-500 hover:text-white">
              {copied ? <IconCheck className="h-4 w-4 text-green-400" /> : <IconCopy className="h-4 w-4" />}{copied ? 'Copied' : 'Copy'}
            </button>
            <button onClick={() => open('/docs')} className="flex items-center gap-1.5 rounded-lg border border-neutral-700 px-3 py-2 text-xs text-neutral-300 hover:border-green-500/60 hover:text-white">
              <IconExternalLink className="h-4 w-4" /> Open playground
            </button>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-neutral-500">
            Point any OpenAI client at this URL (no API key needed) — set <code className="text-neutral-300">baseURL</code> to <code className="text-neutral-300">{BASE}/v1</code>. Run the gateway headless with <code className="text-neutral-300">--server-only</code>.
          </p>
        </div>

        {/* Endpoints */}
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

        {/* Embedded interactive docs (Scalar served by the gateway) */}
        <div className="overflow-hidden rounded-2xl border border-neutral-800 bg-white">
          <iframe
            title="Off Grid AI Gateway — API reference"
            src={`${BASE}/docs`}
            className="h-[70vh] w-full border-0"
          />
        </div>
      </div>
    </div>
  );
}
