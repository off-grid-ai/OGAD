import { useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { AnimatePresence, motion } from 'motion/react'
import AIArtifact from '@offgrid/operator-ui/operator/ai-artifact'
import { TextShimmer } from '@offgrid/operator-ui/operator/text-shimmer'
import { ARTIFACT_KIND_LABELS, type ArtifactKind } from '@renderer/lib/artifact-labels'
import { artifactTitle } from '../../../shared/artifact-title'
import { modelDisplayName } from '@offgrid/models'
import { capturePathFromUrl } from '../../../shared/ogcapture-url'
import { SidePanel } from './SidePanel'
import { ArrowLeft, DownloadSimple, X } from '@phosphor-icons/react'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

// Renders a model-generated artifact (HTML / SVG / Mermaid / React) in a SANDBOXED
// iframe with sandbox="allow-scripts" only and no same-origin access, so generated
// code cannot touch the app or filesystem. Its response CSP blocks every external
// origin except the exact esm.sh host used when a React artifact imports a package.
// Bundled React/Babel/Mermaid keep artifacts without extra packages fully offline.

// 'text'/'image' are catalogued inputs (uploaded file / pasted block / image) —
// shown as plain text or a thumbnail, never executed in the sandbox.
export type Artifact = {
  kind: ArtifactKind
  code: string
  title?: string
  /** Its block has not closed: still streaming, or the answer stopped before it finished. */
  partial?: boolean
}

const KIND_LABEL = ARTIFACT_KIND_LABELS

function escapeForHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * A component draws only its own box; the page around it stayed the frame's white, so a dark hero
 * sat on a bright block filling the rest of the canvas. The page takes the component's background.
 */
const REACT_PAGE_FILL = `<script>(function(){var root=document.getElementById('root');function fill(){var c=root&&root.firstElementChild;if(!c)return;var bg=getComputedStyle(c).backgroundColor;if(!bg||bg==='transparent'||bg==='rgba(0, 0, 0, 0)')return;document.documentElement.style.background=bg;document.body.style.background=bg}new MutationObserver(fill).observe(root,{childList:true});})();</script>`

function revokePreview(url: string): void {
  void window.api.revokeArtifactPreview(url).catch(() => {})
}

interface ArtifactModelLabel {
  id?: string
  name?: string
  kind?: string
  primary?: string
  files?: { name?: string; role?: string }[]
  remoteServerId?: string
}

export function artifactSpeechModelName(
  activeModel: string | null | undefined,
  models: readonly ArtifactModelLabel[]
): string {
  // The active speech pick is stored as an id or a file name: the shared resolver reads both.
  const catalog = models
    .flatMap((model) => (model.id ? [{ ...model, id: model.id }] : []))
    .map((model) => ({
      id: model.id,
      name: model.name,
      kind: model.kind,
      files: [
        ...(model.primary ? [{ name: model.primary }] : []),
        ...(model.files ?? []).flatMap((file) =>
          file.name ? [{ name: file.name, role: file.role }] : []
        )
      ]
    }))
  return modelDisplayName(activeModel, { catalog }) ?? 'Default'
}

// npm packages a React artifact imports beyond react/react-dom (loaded from esm.sh).
function extractPkgs(code: string): string[] {
  const out = new Set<string>()
  const re = /import\s+(?:[\w*{}\n\s,]+from\s+)?['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    let p = m[1]!
    if (p.startsWith('.') || p.startsWith('/')) continue
    p = p.startsWith('@') ? p.split('/').slice(0, 2).join('/') : p.split('/')[0]!
    if (p === 'react' || p === 'react-dom') continue
    out.add(p)
  }
  return [...out]
}

export function ArtifactCanvas({
  artifact,
  onClose,
  onBack,
  width,
  onResize
}: {
  artifact: Artifact
  onClose: () => void
  /** Given when the canvas was opened from a list (the Gallery): returns to that list. */
  onBack?: () => void
  width?: number | null
  onResize?: (w: number) => void
}): React.JSX.Element {
  // Runtime libraries are tagged with the kind they were loaded for, so a kind change never
  // builds a preview with the previous kind's libraries.
  const [loadedRuntime, setLoadedRuntime] = useState<{
    kind: Artifact['kind']
    libs: Record<string, string>
  } | null>(null)
  const runtime = loadedRuntime?.kind === artifact.kind ? loadedRuntime.libs : null
  const [resizing, setResizing] = useState(false)
  // The preview URL is tagged with the HTML it was built from, so the previous artifact's
  // preview is never shown while the new one is being registered.
  const [preview, setPreview] = useState<{ html: string; url: string } | null>(null)
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null)
  const artifactAudioRef = useRef<HTMLAudioElement | null>(null)
  // Holds the active drag's teardown so we can force it on unmount — otherwise
  // closing the canvas mid-drag (e.g. switching chats) leaks the window listeners
  // and keeps firing onResize on a stale setter.
  const endDragRef = useRef<(() => void) | null>(null)

  // Drag the left edge to widen/narrow the canvas (right-anchored: width grows as
  // the cursor moves left). The key to smoothness: while dragging, an overlay sits
  // OVER the iframe so it can't swallow mousemove (the cause of the jumpiness), and
  // updates are rAF-throttled to one per frame.
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    setResizing(true)
    let lastX = e.clientX
    let raf = 0
    const apply = (): void => {
      raf = 0
      onResize?.(Math.min(window.innerWidth * 0.9, Math.max(360, window.innerWidth - lastX)))
    }
    const move = (ev: MouseEvent): void => {
      lastX = ev.clientX
      if (!raf) raf = requestAnimationFrame(apply)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (raf) cancelAnimationFrame(raf)
      endDragRef.current = null
      setResizing(false)
    }
    endDragRef.current = up
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // Force-teardown any in-flight drag if the canvas unmounts.
  useEffect(
    () => () => {
      endDragRef.current?.()
    },
    []
  )

  useEffect(() => {
    let alive = true
    ;(window.api as Partial<typeof window.api>)
      .artifactRuntime?.(artifact.kind)
      .then((r: Record<string, string>) => {
        if (alive) setLoadedRuntime({ kind: artifact.kind, libs: r })
      })
      .catch(() => {
        if (alive) setLoadedRuntime({ kind: artifact.kind, libs: {} })
      })
    return () => {
      alive = false
    }
  }, [artifact.kind])

  const documentHtml = useMemo(() => {
    if (!runtime) return ''
    const { code, kind } = artifact
    if (kind === 'text' || kind === 'image') return ''
    const base =
      '<meta charset="utf-8"><style>html,body{margin:0;background:#fff;color:#111;font-family:system-ui,sans-serif}</style>'
    if (kind === 'html') {
      return /<html|<!doctype/i.test(code)
        ? code
        : `<!doctype html><html><head>${base}</head><body>${code}</body></html>`
    }
    if (kind === 'svg') {
      return `<!doctype html><html><head>${base}</head><body style="display:flex;justify-content:center;align-items:center;height:100vh">${code}</body></html>`
    }
    if (kind === 'mermaid') {
      return `<!doctype html><html><head>${base}<script>${runtime.mermaid || ''}</script></head><body><div class="mermaid">${escapeForHtml(code)}</div><script>try{mermaid.initialize({startOnLoad:true});}catch(e){document.body.innerHTML='<pre style="color:#b91c1c">'+e+'</pre>'}</script></body></html>`
    }
    // react with npm packages → load them from esm.sh (keyless CDN), Babel-compile
    // as an ES module, and dynamic-import it so bare imports resolve via an import
    // map. React itself comes from esm.sh here so all libs share one instance.
    const pkgs = extractPkgs(code)
    if (pkgs.length) {
      const imports: Record<string, string> = {
        react: 'https://esm.sh/react@18',
        'react-dom': 'https://esm.sh/react-dom@18',
        'react-dom/client': 'https://esm.sh/react-dom@18/client',
        'react/jsx-runtime': 'https://esm.sh/react@18/jsx-runtime'
      }
      for (const p of pkgs) imports[p] = `https://esm.sh/${p}?external=react,react-dom`
      return `<!doctype html><html><head>${base}
<script type="importmap">${JSON.stringify({ imports })}</script>
<script>${runtime.babel || ''}</script>
</head><body><div id="root"></div>${REACT_PAGE_FILL}
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
</script></body></html>`
    }

    // react (no extra packages) — fully offline: bundled React/Babel, strip
    // imports/exports, expose hooks as globals, auto-render the default export.
    const stripped = code
      // remove `import X from 'y'`, `import {a,b} from 'y'`, and `import 'y.css'`
      .replace(/import\s+(?:[\w*{}\n\s,]+from\s+)?['"][^'"]+['"];?/g, '')
      // `export default <expr>` -> assign to a sentinel we render
      .replace(/\bexport\s+default\s+/g, '__ogDefault = ')
      // `export const/function/class …` -> plain declaration
      .replace(/\bexport\s+(const|let|var|function|class|default)\b/g, '$1')
    return `<!doctype html><html><head>${base}
<script>
  function __ogShow(msg){ var r=document.getElementById('root')||document.body; r.innerHTML='<pre style="color:#b91c1c;white-space:pre-wrap;padding:12px;font:13px ui-monospace,monospace">'+String(msg).replace(/</g,'&lt;')+'</pre>'; try { parent.postMessage({ __ogArtifactError: String(msg) }, '*'); } catch(e){} }
  window.onerror=function(m,s,l,c,e){ __ogShow(e&&e.stack||m); return false; };
  window.addEventListener('unhandledrejection',function(ev){ __ogShow(ev.reason&&ev.reason.stack||ev.reason); });
</script>
<script>${runtime.react || ''}</script><script>${runtime.reactDom || ''}</script><script>${runtime.babel || ''}</script>
</head><body><div id="root"></div>${REACT_PAGE_FILL}<script type="text/babel" data-presets="react">
var __ogDefault;
const { useState, useEffect, useRef, useMemo, useCallback, useReducer, useContext, useLayoutEffect, createContext, Fragment, memo } = React;
${stripped}
const _root = document.getElementById('root');
const _Comp = (typeof __ogDefault !== 'undefined' && __ogDefault) || (typeof App !== 'undefined' && App) || null;
if (_Comp) { ReactDOM.createRoot(_root).render(React.createElement(_Comp)); }
else { __ogShow('No React component found — define a component named App or a default export.'); }
</script></body></html>`
  }, [artifact, runtime])
  const previewUrl = preview?.html === documentHtml ? preview.url : ''

  useEffect(() => {
    let active = true
    let registeredUrl: string | undefined
    setPreview(null)

    if (documentHtml) {
      window.api
        .createArtifactPreview(documentHtml)
        .then((url) => {
          registeredUrl = url
          if (active) {
            setPreview({ html: documentHtml, url })
          } else {
            revokePreview(url)
          }
        })
        .catch(() => {
          if (active) setPreview(null)
        })
    }

    return () => {
      active = false
      if (registeredUrl) {
        revokePreview(registeredUrl)
      }
    }
  }, [documentHtml])

  useEffect(() => {
    if (artifact.kind !== 'html' || !artifact.code.includes('__ogComicTts')) return
    let active = true
    const sendStatus = (payload: Record<string, unknown>): void => {
      previewFrameRef.current?.contentWindow?.postMessage(
        { __ogComicTts: 'status', ...payload },
        '*'
      )
    }
    const stop = (): void => {
      artifactAudioRef.current?.pause()
      artifactAudioRef.current = null
      sendStatus({ state: 'idle', reason: 'stopped' })
    }
    const sendCatalog = async (): Promise<void> => {
      const [voices, modalities, catalog, installed] = await Promise.all([
        window.api.ttsVoices(),
        window.api.getActiveModalities(),
        window.api.getModelCatalog(),
        window.api.getInstalledModels()
      ])
      const availableModels = (catalog.models as ArtifactModelLabel[])
        .filter((model) => model.kind === 'voice' || model.kind === 'speech')
        .filter(
          (model) =>
            Boolean(model.remoteServerId) ||
            (typeof model.id === 'string' && installed.includes(model.id)) ||
            model.id === modalities.speech ||
            model.primary === modalities.speech ||
            model.files?.some((file) => file.name === modalities.speech)
        )
        .filter((model): model is ArtifactModelLabel & { id: string } => Boolean(model.id))
      const activeCatalogModel = availableModels.find(
        (model) =>
          model.id === modalities.speech ||
          model.primary === modalities.speech ||
          model.files?.some((file) => file.name === modalities.speech)
      )
      const models = availableModels.map((model) => ({
        id: model.id,
        label: model.name ?? model.id
      }))
      if (active) {
        sendStatus({
          voices,
          models,
          activeModel: activeCatalogModel?.id ?? modalities.speech,
          model: artifactSpeechModelName(modalities.speech, catalog.models as ArtifactModelLabel[])
        })
      }
    }
    const onMessage = (event: MessageEvent): void => {
      if (event.source !== previewFrameRef.current?.contentWindow) return
      const message = event.data as
        { __ogComicTts?: string; text?: unknown; voice?: unknown; model?: unknown } | undefined
      if (!message?.__ogComicTts) return
      if (message.__ogComicTts === 'catalog') {
        void sendCatalog().catch(() => {
          if (active) sendStatus({ state: 'error', message: 'SPEECH IS NOT AVAILABLE' })
        })
        return
      }
      if (message.__ogComicTts === 'model' && typeof message.model === 'string') {
        sendStatus({ state: 'model-loading', message: 'SWITCHING MODEL' })
        void window.api
          .getModelCatalog()
          .then((catalog) => {
            const selected = (catalog.models as ArtifactModelLabel[]).find(
              (model) => model.id === message.model
            )
            if (!selected?.id) throw new Error('Speech model not found')
            if (selected.remoteServerId) {
              return window.api.activateModel(selected.id, 'speech')
            }
            const primary =
              selected.primary ??
              selected.files?.find((file) => file.role === 'primary')?.name ??
              selected.files?.[0]?.name ??
              selected.id
            return window.api.setActiveModalModel('speech', primary)
          })
          .then(() => sendCatalog())
          .then(() => {
            if (active) sendStatus({ state: 'idle' })
          })
          .catch(() => {
            if (active) sendStatus({ state: 'error', message: 'MODEL SWITCH FAILED' })
          })
        return
      }
      if (message.__ogComicTts === 'stop') {
        stop()
        return
      }
      if (message.__ogComicTts !== 'speak' || typeof message.text !== 'string') return
      stop()
      sendStatus({ state: 'loading' })
      void window.api
        .speak(message.text, typeof message.voice === 'string' ? message.voice : undefined)
        .then(({ dataUrl }) => {
          if (!active) return
          const audio = new Audio(dataUrl)
          artifactAudioRef.current = audio
          audio.onended = () => {
            if (artifactAudioRef.current === audio) artifactAudioRef.current = null
            sendStatus({ state: 'idle', reason: 'ended' })
          }
          audio.onerror = () => sendStatus({ state: 'error', message: 'SPEECH FAILED' })
          sendStatus({ state: 'playing' })
          return audio.play()
        })
        .catch(() => {
          if (active) sendStatus({ state: 'error', message: 'SPEECH FAILED' })
        })
    }
    window.addEventListener('message', onMessage)
    return () => {
      active = false
      window.removeEventListener('message', onMessage)
      artifactAudioRef.current?.pause()
      artifactAudioRef.current = null
    }
  }, [artifact.code, artifact.kind])

  const saveBlob = (blob: Blob, filename: string): void => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  const slug = (artifact.title || 'artifact').replace(/[^\w-]+/g, '-').toLowerCase() || 'app'

  const download = async (): Promise<void> => {
    // React → a complete, runnable Vite project (.zip): npm install && npm run dev.
    if (artifact.kind === 'react') {
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      const deps: Record<string, string> = { react: '^18.3.1', 'react-dom': '^18.3.1' }
      for (const p of extractPkgs(artifact.code)) deps[p] = 'latest'
      // Ensure the entry has a default export to import.
      const appCode = /export\s+default/.test(artifact.code)
        ? artifact.code
        : `${artifact.code}\n\nexport default (typeof App !== 'undefined' ? App : () => null);\n`
      zip.file(
        'package.json',
        JSON.stringify(
          {
            name: slug,
            private: true,
            version: '0.0.0',
            type: 'module',
            scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
            dependencies: deps,
            devDependencies: { '@vitejs/plugin-react': '^4.3.1', vite: '^5.4.0' }
          },
          null,
          2
        )
      )
      zip.file(
        'vite.config.js',
        `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\nexport default defineConfig({ plugins: [react()] });\n`
      )
      zip.file(
        'index.html',
        `<!doctype html>\n<html>\n  <head><meta charset="utf-8" /><title>${artifact.title || 'App'}</title></head>\n  <body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body>\n</html>\n`
      )
      zip.file(
        'src/main.jsx',
        `import React from 'react';\nimport { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n`
      )
      zip.file('src/App.jsx', appCode)
      zip.file(
        'README.md',
        `# ${artifact.title || 'App'}\n\nGenerated by Off Grid AI.\n\n\`\`\`bash\nnpm install\nnpm run dev\n\`\`\`\n`
      )
      saveBlob(await zip.generateAsync({ type: 'blob' }), `${slug}.zip`)
      return
    }
    // html/svg/mermaid → single runnable file. The app-only ogcapture: protocol cannot work in a
    // normal browser, so embed each allowed local image only in the downloaded copy.
    let downloadableDocument = documentHtml
    if (artifact.kind === 'html') {
      const localUrls = [
        ...new Set(
          [...documentHtml.matchAll(/\bsrc=(['"])(ogcapture:\/\/[^'"]+)\1/gi)].map(
            (match) => match[2]!
          )
        )
      ]
      const embedded = new Map<string, string>()
      for (const url of localUrls) {
        const dataUrl = await window.api.fileDataUrl(capturePathFromUrl(url))
        if (dataUrl) embedded.set(url, dataUrl)
      }
      downloadableDocument = documentHtml.replace(
        /ogcapture:\/\/[^'"\s<]+/gi,
        (url) => embedded.get(url) ?? url
      )
    }
    saveBlob(new Blob([downloadableDocument], { type: 'text/html' }), `${slug}.html`)
  }

  // The artifact itself keeps its own colours: it is sandboxed user content, not app chrome. It is
  // also a live canvas, so the conductor's light and click waves stay off it (data-og-still).
  const previewPane =
    artifact.kind === 'text' ? (
      <div
        data-og-still
        className="prose prose-invert prose-sm h-full max-w-none overflow-auto bg-neutral-950 px-6 py-5 text-sm leading-relaxed text-neutral-200 [&_a]:text-emerald-400 [&_code]:rounded [&_code]:bg-neutral-800 [&_code]:px-1 [&_h1]:mb-3 [&_h1]:mt-1 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-white [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-white [&_li]:my-1 [&_p]:my-2 [&_ul]:list-disc [&_ul]:pl-5"
      >
        <ReactMarkdown>{artifact.code}</ReactMarkdown>
      </div>
    ) : previewUrl ? (
      <div data-og-still className="relative h-full bg-white">
        <iframe
          ref={previewFrameRef}
          key={previewUrl}
          title="artifact"
          sandbox="allow-scripts"
          src={previewUrl}
          className="absolute inset-0 h-full w-full border-0"
          style={{ background: '#fff' }}
        />
      </div>
    ) : (
      <div
        aria-busy="true"
        className="flex h-full items-center justify-center text-xs text-muted-foreground"
      >
        <TextShimmer as="span">Preparing preview…</TextShimmer>
      </div>
    )

  return (
    <SidePanel
      modal={false}
      ariaLabel={artifact.title || artifactTitle(artifact.kind, artifact.code)}
      onClose={onClose}
      className="min-w-[360px] max-w-[90vw]"
      style={{ width: width ? `${width}px` : '30vw' }}
    >
      {/* Resize handle: drag the left edge to slide the canvas wider or narrower. The pill grows
          and glows under the pointer exactly as the library's resizable divider does. */}
      <div
        onMouseDown={startResize}
        title="Drag to resize"
        data-active={resizing || undefined}
        className="group/handle absolute left-[-3px] top-0 z-20 flex h-full w-2.5 cursor-col-resize items-center justify-center"
      >
        <span className="h-8 w-1 rounded-full bg-border opacity-0 transition-[opacity,height,background-color,box-shadow] duration-300 group-hover/handle:h-10 group-hover/handle:bg-primary/70 group-hover/handle:opacity-100 group-data-[active]/handle:h-12 group-data-[active]/handle:bg-primary group-data-[active]/handle:opacity-100 group-data-[active]/handle:shadow-[0_0_14px_rgb(var(--og-rgb-primary)/0.7)]" />
      </div>
      {/* While dragging, this overlay sits OVER the iframe so it can't swallow the
          mousemove events — without it the drag stalls and jumps. */}
      {resizing && <div className="fixed inset-0 z-[60] cursor-col-resize select-none" />}
      <div className="flex items-center justify-between gap-4 border-b border-border/60 px-6 py-3">
        <div className="flex min-w-0 items-center gap-2">
          {onBack ? (
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Back to gallery"
              title="Back to gallery"
              onClick={onBack}
              className="-ml-2 shrink-0"
            >
              <ArrowLeft />
            </Button>
          ) : null}
          <span className="min-w-0 truncate text-sm text-foreground">
            {artifact.title || artifactTitle(artifact.kind, artifact.code)}
          </span>
        </div>
        {/* Its own provider: the canvas can open outside the app shell's provider. */}
        <TooltipProvider delayDuration={300}>
          <div className="flex shrink-0 items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  aria-label="Download"
                  onClick={download}
                >
                  <DownloadSimple />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Download</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Close"
                  onClick={onClose}
                >
                  <X />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Close</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>
      {/* The inspection chapter's artifact frame: preview and code travel along one axis, with
          copy beside them. The frame fills the panel; its panes take the remaining height. */}
      <div className="flex min-h-0 flex-1 flex-col p-3">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${artifact.kind}:${artifact.title ?? ''}`}
            initial={{ opacity: 0, y: 10, filter: 'blur(6px)' }}
            animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
            exit={{ opacity: 0, y: -6, filter: 'blur(6px)' }}
            transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <AIArtifact
              title={KIND_LABEL[artifact.kind]}
              preview={previewPane}
              code={artifact.code}
              copyText={artifact.code}
              className="flex min-h-0 flex-1 flex-col border-border/60 bg-background/60 [&>div:last-child>div>div]:h-full [&>div:last-child>div>div]:p-0 [&>div:last-child>div]:h-full [&>div:last-child]:min-h-0 [&>div:last-child]:flex-1 [&_pre]:h-full [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:break-words"
            />
          </motion.div>
        </AnimatePresence>
      </div>
    </SidePanel>
  )
}

const JSX_SIGNAL =
  /(<[A-Za-z][^>]*>|<\/[A-Za-z]|=>\s*\(?\s*<|React\.|useState|ReactDOM|export default function|className=)/

/** Extract a renderable artifact from assistant markdown, if any. */
export function parseArtifact(content: string): Artifact | null {
  // React first: COMBINE all jsx/tsx/react blocks so multi-file responses
  // (App.js + Child.js) run together — imports are stripped, so every component
  // ends up in one shared scope and relative imports resolve.
  const reactBlocks = [...content.matchAll(/```(?:jsx|tsx|react)\s*\n([\s\S]*?)```/gi)].map((b) =>
    b[1]!.trim()
  )
  if (reactBlocks.length) return { kind: 'react', code: reactBlocks.join('\n\n') }

  // A single html/svg/mermaid artifact.
  const m = content.match(/```(html|svg|mermaid)\s*\n([\s\S]*?)```/i)
  if (m) {
    const lang = m[1]!.toLowerCase()
    return {
      kind: lang === 'svg' ? 'svg' : lang === 'mermaid' ? 'mermaid' : 'html',
      code: m[2]!.trim()
    }
  }

  // Plain js/ts blocks that look like React — combine them too.
  const jsBlocks = [
    ...content.matchAll(/```(?:javascript|js|typescript|ts)\s*\n([\s\S]*?)```/gi)
  ].map((b) => b[1]!.trim())
  if (jsBlocks.length && jsBlocks.some((b) => JSX_SIGNAL.test(b))) {
    return { kind: 'react', code: jsBlocks.join('\n\n') }
  }

  // A bare <svg>…</svg> with no fence is still a valid artifact.
  const svg = content.match(/<svg[\s\S]*<\/svg>/i)
  if (svg) return { kind: 'svg', code: svg[0] }

  // A fenced markdown/doc block becomes a rendered document artifact.
  const md = content.match(/```(?:markdown|md)\s*\n([\s\S]*?)```/i)
  if (md) return { kind: 'text', code: md[1]!.trim() }
  return partialArtifact(content)
}

/**
 * An artifact whose block is still open: the answer is streaming it, or stopped before it closed.
 * Recognised from its first line so the chat shows the artifact card at once (and the canvas can
 * render it as it arrives) instead of a wall of raw code. A whole HTML document with no fence at
 * all counts too.
 */
function partialArtifact(content: string): Artifact | null {
  const open = content.match(/```(html|svg|mermaid|jsx|tsx|react)\s*\n([\s\S]*)$/i)
  if (open) {
    const lang = open[1]!.toLowerCase()
    const kind: ArtifactKind =
      lang === 'svg' ? 'svg' : lang === 'mermaid' ? 'mermaid' : lang === 'html' ? 'html' : 'react'
    return { kind, code: open[2]!.trim(), partial: true }
  }
  const bare = content.match(/(?:^|\n)\s*(<!doctype html[\s\S]*|<html[\s>][\s\S]*)$/i)
  if (bare) {
    const code = bare[1]!.trim()
    return { kind: 'html', code, ...(/<\/html>\s*$/i.test(code) ? {} : { partial: true }) }
  }
  return null
}
