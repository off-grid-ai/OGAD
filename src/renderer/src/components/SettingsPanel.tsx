import { useEffect, useState } from 'react';

// Right-side Settings panel (same pattern as SkillsPanel/ArtifactCanvas).
// Tabs: Model (inference params), Voice (Kokoro TTS), Tools (built-in, read-only),
// Connectors (MCP servers — the user's reusable tool library). All on-device.

type Tab = 'model' | 'voice' | 'tools' | 'connectors';
type LlmSettings = { temperature?: number; ctxSize?: number; topP?: number; topK?: number; minP?: number; repeatPenalty?: number; maxTokens?: number; systemPrompt?: string };
type Connector = { id: number; name: string; url?: string | null; transport?: string; enabled?: number | boolean };

const CTX_OPTIONS = [4096, 8192, 16384, 32768, 65536, 131072];

function Row({ label, hint, value, children }: { label: string; hint?: string; value?: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center justify-between">
        <label className="text-[11px] uppercase tracking-wide text-neutral-400">{label}</label>
        {value !== undefined ? <span className="text-xs text-green-500">{value}</span> : null}
      </div>
      {children}
      {hint ? <p className="mt-1 text-[10px] text-neutral-600">{hint}</p> : null}
    </div>
  );
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('model');
  const [s, setS] = useState<LlmSettings>({});
  const [voices, setVoices] = useState<string[]>([]);
  const [voice, setVoice] = useState<string>('af_heart');
  const [tools, setTools] = useState<{ name: string; description: string; enabled?: boolean }[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [newConn, setNewConn] = useState({ name: '', url: '' });
  const [voiceState, setVoiceState] = useState<'idle' | 'generating' | 'playing' | 'error'>('idle');

  useEffect(() => {
    window.api.getLlmSettings?.().then((v: LlmSettings) => setS(v || {})).catch(() => {});
    window.api.ttsVoices?.().then((v: string[]) => setVoices(v || [])).catch(() => {});
    window.api.listTools?.().then((t: { name: string; description: string }[]) => setTools(t || [])).catch(() => {});
    window.api.getSettings?.().then((all: Record<string, unknown>) => { if (all?.ttsVoice) setVoice(String(all.ttsVoice)); }).catch(() => {});
    refreshConnectors();
  }, []);

  const refreshConnectors = (): void => {
    window.api.mcpList?.().then((c: Connector[]) => setConnectors(c || [])).catch(() => setConnectors([]));
  };

  // Persist one inference setting (optimistic) — backend applies it per-request.
  const set = (patch: LlmSettings): void => {
    setS(prev => ({ ...prev, ...patch }));
    window.api.setLlmSettings?.(patch);
  };

  const pickVoice = (v: string): void => {
    setVoice(v);
    window.api.saveSetting?.('ttsVoice', v);
  };

  const testVoice = async (): Promise<void> => {
    setVoiceState('generating');
    try {
      const res = await window.api.speak('This is the Off Grid voice.', voice);
      if (!res?.dataUrl) throw new Error('No audio returned');
      const audio = new Audio(res.dataUrl);
      audio.onended = () => setVoiceState('idle');
      audio.onerror = () => { console.error('[voice] playback error', audio.error); setVoiceState('error'); };
      // Safety: never get stuck if onended doesn't fire.
      audio.onloadedmetadata = () => setTimeout(() => setVoiceState(s => (s === 'playing' ? 'idle' : s)), (audio.duration + 1) * 1000);
      setVoiceState('playing');
      await audio.play();
    } catch (e) {
      console.error('[voice] test failed', e);
      setVoiceState('error');
    }
  };

  const addConnector = async (): Promise<void> => {
    if (!newConn.name.trim() || !newConn.url.trim()) return;
    await window.api.mcpAdd?.({ name: newConn.name.trim(), transport: 'http', url: newConn.url.trim() });
    setNewConn({ name: '', url: '' });
    refreshConnectors();
  };

  return (
    <div className="fixed right-0 top-0 bottom-0 z-50 flex w-[30vw] min-w-[420px] flex-col border-l border-neutral-800 bg-neutral-950 font-mono shadow-2xl">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm text-neutral-200">
          <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-green-500">Settings</span>
        </div>
        <button onClick={onClose} className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition-colors hover:text-white">Close</button>
      </div>

      <div className="flex items-center gap-1 border-b border-neutral-800 px-3 py-2">
        {(['model', 'voice', 'tools', 'connectors'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1 text-xs capitalize transition-colors ${tab === t ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-neutral-300'}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
        {tab === 'model' && (
          <>
            <Row label="Temperature" value={(s.temperature ?? 0.7).toFixed(2)} hint="Lower = focused, higher = creative.">
              <input type="range" min={0} max={1.5} step={0.05} value={s.temperature ?? 0.7} onChange={e => set({ temperature: Number(e.target.value) })} className="w-full accent-green-500" />
            </Row>
            <Row label="Top-P" value={(s.topP ?? 0.95).toFixed(2)} hint="Nucleus sampling cutoff.">
              <input type="range" min={0} max={1} step={0.01} value={s.topP ?? 0.95} onChange={e => set({ topP: Number(e.target.value) })} className="w-full accent-green-500" />
            </Row>
            <Row label="Top-K" value={String(s.topK ?? 40)} hint="0 disables. Limits candidate tokens.">
              <input type="range" min={0} max={100} step={1} value={s.topK ?? 40} onChange={e => set({ topK: Number(e.target.value) })} className="w-full accent-green-500" />
            </Row>
            <Row label="Min-P" value={(s.minP ?? 0.05).toFixed(2)} hint="Min probability relative to the top token.">
              <input type="range" min={0} max={0.5} step={0.01} value={s.minP ?? 0.05} onChange={e => set({ minP: Number(e.target.value) })} className="w-full accent-green-500" />
            </Row>
            <Row label="Repeat penalty" value={(s.repeatPenalty ?? 1.1).toFixed(2)} hint="Higher discourages repetition.">
              <input type="range" min={1} max={1.5} step={0.01} value={s.repeatPenalty ?? 1.1} onChange={e => set({ repeatPenalty: Number(e.target.value) })} className="w-full accent-green-500" />
            </Row>
            <Row label="Max tokens" value={String(s.maxTokens ?? 2048)} hint="Cap on the response length (must fit within the context window).">
              <input type="range" min={256} max={32768} step={256} value={s.maxTokens ?? 2048} onChange={e => set({ maxTokens: Number(e.target.value) })} className="w-full accent-green-500" />
            </Row>
            <Row label="Context window" hint="Larger holds more history; changing it reloads the model.">
              <select value={s.ctxSize ?? 32768} onChange={e => set({ ctxSize: Number(e.target.value) })} className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200 outline-none focus:border-green-500">
                {CTX_OPTIONS.map(c => <option key={c} value={c}>{c >= 1024 ? `${c / 1024}K` : c} tokens{c === 65536 ? ' (default)' : c === 131072 ? ' (max — heavy)' : ''}</option>)}
              </select>
            </Row>
            <Row label="System prompt" hint="Prepended to every chat as a system message. Leave blank for the default.">
              <textarea value={s.systemPrompt ?? ''} onChange={e => set({ systemPrompt: e.target.value })} rows={5} placeholder="e.g. You are a concise, technical assistant." className="w-full resize-none rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200 placeholder-neutral-600 outline-none focus:border-green-500" />
            </Row>
          </>
        )}

        {tab === 'voice' && (
          <>
            <Row label="Voice" hint="Kokoro on-device voices (af_ = US female, am_ = US male, bf_/bm_ = British).">
              <select value={voice} onChange={e => pickVoice(e.target.value)} className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-neutral-200 outline-none focus:border-green-500">
                {(voices.length ? voices : [voice]).map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </Row>
            <button onClick={testVoice} disabled={voiceState === 'generating' || voiceState === 'playing'} className="rounded-md bg-green-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-green-500 disabled:opacity-40">
              {voiceState === 'generating' ? 'Generating…' : voiceState === 'playing' ? 'Playing…' : 'Test voice'}
            </button>
            {voiceState === 'error' ? <span className="ml-2 text-[11px] text-red-400">Couldn’t play — check the console.</span> : null}
          </>
        )}

        {tab === 'tools' && (
          <>
            <p className="mb-3 text-[11px] text-neutral-500">Built-in tools the model can call when “Tools” is on in the composer.</p>
            {tools.length === 0 ? <p className="text-xs text-neutral-600">No tools.</p> : (
              <div className="flex flex-col gap-2">
                {tools.map(t => (
                  <div key={t.name} className="flex items-start justify-between gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2">
                    <div className="min-w-0">
                      <div className={`text-sm ${t.enabled === false ? 'text-neutral-500' : 'text-green-500'}`}>{t.name}</div>
                      <div className="text-[11px] text-neutral-500">{t.description}</div>
                    </div>
                    <button
                      onClick={() => { const next = t.enabled === false; window.api.setToolEnabled?.(t.name, next); setTools(prev => prev.map(x => (x.name === t.name ? { ...x, enabled: next } : x))); }}
                      className={`shrink-0 rounded px-2 py-1 text-[11px] ${t.enabled === false ? 'text-neutral-500' : 'text-green-500'}`}
                    >
                      {t.enabled === false ? 'Off' : 'On'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'connectors' && (
          <>
            <p className="mb-3 text-[11px] text-neutral-500">Connect MCP servers — your reusable tool library (web search, fetch, etc.). Add an HTTP MCP endpoint:</p>
            <div className="mb-4 flex flex-col gap-2 rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
              <input value={newConn.name} onChange={e => setNewConn({ ...newConn, name: e.target.value })} placeholder="Name (e.g. Brave Search)" className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-green-500" />
              <input value={newConn.url} onChange={e => setNewConn({ ...newConn, url: e.target.value })} placeholder="https://… (MCP HTTP URL)" className="rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs text-neutral-200 placeholder-neutral-600 outline-none focus:border-green-500" />
              <button onClick={addConnector} disabled={!newConn.name.trim() || !newConn.url.trim()} className="self-start rounded-md bg-green-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-green-500 disabled:opacity-40">Add connector</button>
            </div>
            {connectors.length === 0 ? <p className="text-xs text-neutral-600">No connectors yet.</p> : (
              <div className="flex flex-col gap-2">
                {connectors.map(c => (
                  <div key={c.id} className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm text-neutral-200">{c.name}</div>
                      {c.url ? <div className="truncate text-[10px] text-neutral-600">{c.url}</div> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={async () => { await window.api.mcpSetEnabled?.(c.id, !c.enabled); refreshConnectors(); }} className={`rounded px-2 py-1 text-[11px] ${c.enabled ? 'text-green-500' : 'text-neutral-500'}`}>{c.enabled ? 'On' : 'Off'}</button>
                      <button onClick={async () => { await window.api.mcpRemove?.(c.id); refreshConnectors(); }} className="rounded px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10">Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
