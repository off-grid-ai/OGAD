import { useEffect, useMemo, useState } from 'react';
import { SandpackProvider, SandpackLayout, SandpackPreview, SandpackCodeEditor } from '@codesandbox/sandpack-react';

// Renders a model-generated artifact. HTML / SVG / Mermaid run in a SANDBOXED
// iframe (sandbox="allow-scripts", no same-origin) with runtime libs inlined
// offline. React artifacts run in Sandpack — a real in-browser bundler that
// resolves npm imports — so the model can `import` libraries and they work.

export type Artifact = { kind: 'html' | 'svg' | 'mermaid' | 'react'; code: string; title?: string };

const KIND_LABEL: Record<Artifact['kind'], string> = {
  html: 'HTML', svg: 'SVG', mermaid: 'Diagram', react: 'React',
};

function escapeForHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Pull the npm packages a React artifact imports (skip relative paths and the
// react/react-dom the template already provides) so Sandpack installs them.
function extractDeps(code: string): Record<string, string> {
  const deps: Record<string, string> = {};
  const re = /import\s+(?:[\w*{}\n\s,]+from\s+)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let pkg = m[1];
    if (pkg.startsWith('.') || pkg.startsWith('/')) continue;
    pkg = pkg.startsWith('@') ? pkg.split('/').slice(0, 2).join('/') : pkg.split('/')[0];
    if (pkg === 'react' || pkg === 'react-dom') continue;
    deps[pkg] = 'latest';
  }
  return deps;
}

// Tolerant entry point: render whatever the artifact exports — default, a named
// `App`, or the first function/class export — so we don't depend on an exact shape.
const BOOTSTRAP = `import React from 'react';
import { createRoot } from 'react-dom/client';
import * as Mod from './App';
const Comp = Mod.default || Mod.App || Object.values(Mod).find((v) => typeof v === 'function');
const root = createRoot(document.getElementById('root'));
if (Comp) root.render(React.createElement(Comp));
else document.body.innerHTML = '<pre style="color:#b91c1c;padding:12px">No React component exported. Define a default export or an App component.</pre>';
`;

function ReactSandpack({ code, showEditor }: { code: string; showEditor: boolean }) {
  const deps = useMemo(() => extractDeps(code), [code]);
  return (
    <SandpackProvider
      template="react"
      theme="dark"
      files={{ '/index.js': { code: BOOTSTRAP, hidden: true }, '/App.js': { code, active: true } }}
      customSetup={{ dependencies: deps }}
      options={{ recompileMode: 'delayed', recompileDelay: 400 }}
      style={{ height: '100%' }}
    >
      <SandpackLayout style={{ height: '100%', border: 'none', borderRadius: 0 }}>
        {showEditor && <SandpackCodeEditor style={{ height: '100%' }} showLineNumbers showTabs={false} />}
        <SandpackPreview style={{ height: '100%' }} showOpenInCodeSandbox={false} showRefreshButton />
      </SandpackLayout>
    </SandpackProvider>
  );
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
        {artifact.kind === 'react' ? (
          <ReactSandpack code={artifact.code} showEditor={view === 'code'} />
        ) : view === 'preview' ? (
          <iframe title="artifact" sandbox="allow-scripts" srcDoc={srcdoc} className="h-full w-full border-0 bg-white" />
        ) : (
          <pre className="h-full overflow-auto bg-neutral-950 p-4 text-xs text-neutral-300">{artifact.code}</pre>
        )}
      </div>
    </div>
  );
}

/** Extract the first renderable artifact from assistant markdown, if any. */
export function parseArtifact(content: string): Artifact | null {
  let m = content.match(/```(html|svg|mermaid|jsx|tsx|react)\s*\n([\s\S]*?)```/i);
  if (!m) {
    // A plain ```js / ```javascript / ```ts block is a React artifact if it looks
    // like one (JSX or React APIs) — the model often fences React as js.
    const js = content.match(/```(?:javascript|js|typescript|ts)\s*\n([\s\S]*?)```/i);
    if (js && /(<[A-Za-z][^>]*>|<\/[A-Za-z]|=>\s*\(?\s*<|React\.|useState|ReactDOM|export default function|className=)/.test(js[1])) {
      return { kind: 'react', code: js[1].trim() };
    }
    // A bare <svg>…</svg> with no fence is still a valid artifact.
    const svg = content.match(/<svg[\s\S]*<\/svg>/i);
    if (svg) return { kind: 'svg', code: svg[0] };
    return null;
  }
  const lang = m[1].toLowerCase();
  const kind: Artifact['kind'] = lang === 'svg' ? 'svg' : lang === 'mermaid' ? 'mermaid' : lang === 'html' ? 'html' : 'react';
  return { kind, code: m[2].trim() };
}
