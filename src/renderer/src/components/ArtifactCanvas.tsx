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

// npm packages a React artifact imports beyond react/react-dom (loaded from esm.sh).
function extractPkgs(code: string): string[] {
  const out = new Set<string>();
  const re = /import\s+(?:[\w*{}\n\s,]+from\s+)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let p = m[1];
    if (p.startsWith('.') || p.startsWith('/')) continue;
    p = p.startsWith('@') ? p.split('/').slice(0, 2).join('/') : p.split('/')[0];
    if (p === 'react' || p === 'react-dom') continue;
    out.add(p);
  }
  return [...out];
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
    // react with npm packages → load them from esm.sh (keyless CDN), Babel-compile
    // as an ES module, and dynamic-import it so bare imports resolve via an import
    // map. React itself comes from esm.sh here so all libs share one instance.
    const pkgs = extractPkgs(code);
    if (pkgs.length) {
      const imports: Record<string, string> = {
        react: 'https://esm.sh/react@18',
        'react-dom': 'https://esm.sh/react-dom@18',
        'react-dom/client': 'https://esm.sh/react-dom@18/client',
        'react/jsx-runtime': 'https://esm.sh/react@18/jsx-runtime',
      };
      for (const p of pkgs) imports[p] = `https://esm.sh/${p}?external=react,react-dom`;
      return `<!doctype html><html><head>${base}
<script type="importmap">${JSON.stringify({ imports })}</script>
<script>${runtime.babel || ''}</script>
</head><body><div id="root"></div>
<script>
(async () => {
  try {
    const out = Babel.transform(${JSON.stringify(code)}, { presets: [['react', { runtime: 'automatic' }]], sourceType: 'module', filename: 'App.jsx' }).code;
    const mod = await import(URL.createObjectURL(new Blob([out], { type: 'text/javascript' })));
    const C = mod.default || mod.App || Object.values(mod).find((v) => typeof v === 'function');
    const React = (await import('react')).default;
    const { createRoot } = await import('react-dom/client');
    if (C) createRoot(document.getElementById('root')).render(React.createElement(C));
    else document.body.innerHTML = '<pre style="color:#b91c1c">No React component exported.</pre>';
  } catch (e) { document.body.innerHTML = '<pre style="color:#b91c1c;white-space:pre-wrap;padding:12px">'+(e && e.stack || e)+'</pre>'; }
})();
</script></body></html>`;
    }

    // react (no extra packages) — fully offline: bundled React/Babel, strip
    // imports/exports, expose hooks as globals, auto-render the default export.
    const stripped = code
      // remove `import X from 'y'`, `import {a,b} from 'y'`, and `import 'y.css'`
      .replace(/import\s+(?:[\w*{}\n\s,]+from\s+)?['"][^'"]+['"];?/g, '')
      // `export default <expr>` -> assign to a sentinel we render
      .replace(/\bexport\s+default\s+/g, '__ogDefault = ')
      // `export const/function/class …` -> plain declaration
      .replace(/\bexport\s+(const|let|var|function|class|default)\b/g, '$1');
    return `<!doctype html><html><head>${base}
<script>
  function __ogShow(msg){ var r=document.getElementById('root')||document.body; r.innerHTML='<pre style="color:#b91c1c;white-space:pre-wrap;padding:12px;font:13px ui-monospace,monospace">'+String(msg).replace(/</g,'&lt;')+'</pre>'; }
  window.onerror=function(m,s,l,c,e){ console.log('[artifact] onerror', e&&e.stack||m); __ogShow(e&&e.stack||m); return false; };
  window.addEventListener('unhandledrejection',function(ev){ console.log('[artifact] rejection', ev.reason); __ogShow(ev.reason&&ev.reason.stack||ev.reason); });
</script>
<script>${runtime.react || ''}</script><script>${runtime.reactDom || ''}</script><script>${runtime.babel || ''}</script>
</head><body><div id="root">Loading…</div><script type="text/babel" data-presets="react">
console.log('[artifact] runner start; React=' + (typeof React) + ' ReactDOM=' + (typeof ReactDOM) + ' Babel=' + (typeof Babel));
var __ogDefault;
const { useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, useLayoutEffect, createContext, Fragment, memo } = React;
${stripped}
const _root = document.getElementById('root');
const _Comp = (typeof __ogDefault !== 'undefined' && __ogDefault) || (typeof App !== 'undefined' && App) || null;
console.log('[artifact] component=' + (_Comp ? (_Comp.name || 'anonymous') : 'NONE FOUND'));
_root.innerHTML = '';
if (_Comp) { ReactDOM.createRoot(_root).render(React.createElement(_Comp)); console.log('[artifact] render() called'); }
else { __ogShow('No React component found — define a component named App or a default export.'); }
</script></body></html>`;
  }, [artifact, runtime]);

  const saveBlob = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const slug = (artifact.title || 'artifact').replace(/[^\w-]+/g, '-').toLowerCase() || 'app';

  const download = async (): Promise<void> => {
    // React → a complete, runnable Vite project (.zip): npm install && npm run dev.
    if (artifact.kind === 'react') {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      const deps: Record<string, string> = { react: '^18.3.1', 'react-dom': '^18.3.1' };
      for (const p of extractPkgs(artifact.code)) deps[p] = 'latest';
      // Ensure the entry has a default export to import.
      const appCode = /export\s+default/.test(artifact.code) ? artifact.code : `${artifact.code}\n\nexport default (typeof App !== 'undefined' ? App : () => null);\n`;
      zip.file('package.json', JSON.stringify({
        name: slug, private: true, version: '0.0.0', type: 'module',
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        dependencies: deps,
        devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.4.0' },
      }, null, 2));
      zip.file('vite.config.js', `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n`);
      zip.file('index.html', `<!doctype html>\n<html>\n  <head><meta charset="utf-8" /><title>${artifact.title || 'App'}</title></head>\n  <body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>\n</html>\n`);
      zip.file('src/main.jsx', `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n`);
      zip.file('src/App.jsx', appCode);
      zip.file('README.md', `# ${artifact.title || 'App'}\n\nGenerated by Off Grid AI.\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`);
      saveBlob(await zip.generateAsync({ type: 'blob' }), `${slug}.zip`);
      return;
    }
    // html/svg/mermaid → single runnable file.
    saveBlob(new Blob([srcdoc], { type: 'text/html' }), `${slug}.html`);
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
