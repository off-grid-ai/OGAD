import { useEffect, useMemo, useState } from 'react';

// Renders a model-generated artifact (HTML / SVG / Mermaid / React) in a SANDBOXED
// iframe — sandbox="allow-scripts" only, no same-origin, no network — so generated
// code can't touch the app, filesystem, or network. Runtime libs (React/Babel/
// Mermaid) are inlined from the bundled offline copies, so it runs fully on-device.

export type Artifact = { kind: 'html' | 'svg' | 'mermaid' | 'react'; code: string; title?: string };

const KIND_LABEL: Record<Artifact['kind'], string> = {
  html: 'HTML', svg: 'SVG', mermaid: 'Diagram', react: 'React',
};

function escapeForHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function ArtifactCanvas({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const [runtime, setRuntime] = useState<Record<string, string> | null>(null);
  const [view, setView] = useState<'preview' | 'code'>('preview');

  useEffect(() => {
    let alive = true;
    window.api.artifactRuntime?.(artifact.kind)
      .then((r: Record<string, string>) => { if (alive) setRuntime(r || {}); })
      .catch(() => setRuntime({}));
    return () => { alive = false; };
  }, [artifact.kind]);

  const srcdoc = useMemo(() => {
    if (!runtime) return '';
    const { code, kind } = artifact;
    const base = '<meta charset="utf-8"><style>html,body{margin:0;background:#fff;color:#111;font-family:system-ui,sans-serif}</style>';
    if (kind === 'html') {
      return /<html|<!doctype/i.test(code) ? code : `<!doctype html><html><head>${base}</head><body>${code}</body></html>`;
    }
    if (kind === 'svg') {
      return `<!doctype html><html><head>${base}</head><body style="display:flex;justify-content:center;align-items:center;height:100vh">${code}</body></html>`;
    }
    if (kind === 'mermaid') {
      return `<!doctype html><html><head>${base}<script>${runtime.mermaid || ''}</script></head><body><div class="mermaid">${escapeForHtml(code)}</div><script>try{mermaid.initialize({startOnLoad:true});}catch(e){document.body.innerHTML='<pre style="color:#b91c1c">'+e+'</pre>'}</script></body></html>`;
    }
    // react — the model writes idiomatic React (import React, hooks, export
    // default). In-browser Babel can't resolve ESM, so strip imports/exports,
    // expose React + hooks as globals, and auto-render the default export (or an
    // `App`) into #root.
    const stripped = code
      // remove `import X from 'y'`, `import {a,b} from 'y'`, and `import 'y.css'`
      .replace(/import\s+(?:[\w*{}\n\s,]+from\s+)?['"][^'"]+['"];?/g, '')
      // `export default <expr>` -> assign to a sentinel we render
      .replace(/\bexport\s+default\s+/g, '__ogDefault = ')
      // `export const/function/class …` -> plain declaration
      .replace(/\bexport\s+(const|let|var|function|class|default)\b/g, '$1');
    return `<!doctype html><html><head>${base}<script>${runtime.react || ''}</script><script>${runtime.reactDom || ''}</script><script>${runtime.babel || ''}</script></head><body><div id="root"></div><script type="text/babel" data-presets="react">
var __ogDefault;
const { useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, useLayoutEffect, createContext, Fragment, memo } = React;
try {
${stripped}
const _root = document.getElementById('root');
const _Comp = (typeof __ogDefault !== 'undefined' && __ogDefault) || (typeof App !== 'undefined' && App) || null;
if (_root.hasChildNodes()) { /* code rendered itself */ }
else if (_Comp) { ReactDOM.createRoot(_root).render(React.createElement(_Comp)); }
else { document.body.innerHTML = '<pre style="color:#b91c1c;white-space:pre-wrap">No React component found — define a component named App or a default export.</pre>'; }
} catch (e) { document.body.innerHTML = '<pre style="color:#b91c1c;white-space:pre-wrap">'+(e && e.stack || e)+'</pre>'; }
</script></body></html>`;
  }, [artifact, runtime]);

  const download = (): void => {
    const isReact = artifact.kind === 'react';
    const blob = new Blob([isReact ? artifact.code : srcdoc], { type: isReact ? 'text/jsx' : 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(artifact.title || 'artifact').replace(/[^\w-]+/g, '-')}.${isReact ? 'jsx' : 'html'}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed right-0 top-0 bottom-0 z-50 flex w-[44vw] min-w-[420px] flex-col border-l border-neutral-800 bg-neutral-950 font-mono shadow-2xl">
      <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm text-neutral-200">
          <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-green-500">{KIND_LABEL[artifact.kind]}</span>
          <span className="truncate">{artifact.title || 'Canvas'}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-neutral-800 p-0.5">
            <button onClick={() => setView('preview')} className={`rounded px-3 py-1 text-xs transition-colors ${view === 'preview' ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-neutral-300'}`}>Preview</button>
            <button onClick={() => setView('code')} className={`rounded px-3 py-1 text-xs transition-colors ${view === 'code' ? 'bg-neutral-800 text-green-500' : 'text-neutral-500 hover:text-neutral-300'}`}>Code</button>
          </div>
          <button onClick={download} className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition-colors hover:border-green-500 hover:text-green-500">Download</button>
          <button onClick={onClose} className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-300 transition-colors hover:text-white">Close</button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'preview' ? (
          <iframe title="artifact" sandbox="allow-scripts" srcDoc={srcdoc} className="h-full w-full border-0 bg-white" />
        ) : (
          <pre className="h-full overflow-auto bg-neutral-950 p-4 text-xs text-neutral-300">{artifact.code}</pre>
        )}
      </div>
    </div>
  );
}

const JSX_SIGNAL = /(<[A-Za-z][^>]*>|<\/[A-Za-z]|=>\s*\(?\s*<|React\.|useState|ReactDOM|export default function|className=)/;

/** Extract a renderable artifact from assistant markdown, if any. */
export function parseArtifact(content: string): Artifact | null {
  // React first: COMBINE all jsx/tsx/react blocks so multi-file responses
  // (App.js + Child.js) run together — imports are stripped, so every component
  // ends up in one shared scope and relative imports resolve.
  const reactBlocks = [...content.matchAll(/```(?:jsx|tsx|react)\s*\n([\s\S]*?)```/gi)].map((b) => b[1].trim());
  if (reactBlocks.length) return { kind: 'react', code: reactBlocks.join('\n\n') };

  // A single html/svg/mermaid artifact.
  const m = content.match(/```(html|svg|mermaid)\s*\n([\s\S]*?)```/i);
  if (m) {
    const lang = m[1].toLowerCase();
    return { kind: lang === 'svg' ? 'svg' : lang === 'mermaid' ? 'mermaid' : 'html', code: m[2].trim() };
  }

  // Plain js/ts blocks that look like React — combine them too.
  const jsBlocks = [...content.matchAll(/```(?:javascript|js|typescript|ts)\s*\n([\s\S]*?)```/gi)].map((b) => b[1].trim());
  if (jsBlocks.length && jsBlocks.some((b) => JSX_SIGNAL.test(b))) {
    return { kind: 'react', code: jsBlocks.join('\n\n') };
  }

  // A bare <svg>…</svg> with no fence is still a valid artifact.
  const svg = content.match(/<svg[\s\S]*<\/svg>/i);
  if (svg) return { kind: 'svg', code: svg[0] };
  return null;
}
