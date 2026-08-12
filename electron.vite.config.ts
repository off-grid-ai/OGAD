import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createRendererContentSecurityPolicy } from './src/shared/renderer-csp'

// Open-core seam: the private `pro/` git submodule is present only in paid
// builds. When it's missing (free / contributor build) we alias the pro entry
// points to a null stub so the app builds and runs with core features only.
// Mirrors mobile/metro.config.js (proExists + extraNodeModules).
// OFFGRID_FORCE_CORE=1 builds the free/core artifact even when the pro/ submodule
// is checked out — lets CI (and local) produce BOTH core and pro DMGs from one
// checkout without removing the submodule.
const forceCore = process.env.OFFGRID_FORCE_CORE === '1'
const proExists = !forceCore && existsSync(resolve('pro/package.json'))
const stub = resolve('src/bootstrap/proStub.ts')
const proMain = proExists ? resolve('pro/main/index.ts') : stub
const proRenderer = proExists ? resolve('pro/renderer/index.tsx') : stub

// Baked into every bundle so runtime code can tell a pro build from a free build
// without relying on an env var default (which can't distinguish "unset" from "pro").
const proDefine = { __OFFGRID_PRO__: JSON.stringify(proExists) }

// Sourcemaps, for one purpose: making the e2e run's coverage land on source.
//
// Playwright launches the BUILT app, so V8 records execution against out/main/index.ts's bundle - a
// single 17k-statement file that says nothing about which of src/main/*.ts and pro/main/*.ts ran.
// Without a map, e2e coverage cannot be joined to a diff, and 25 specs that drive the real app
// (devices-sync.spec.ts stands up a synthetic peer with a real SyncEngine) go on counting for nothing.
//
// Gated on the same variable that turns the capture on, so a normal build - and every shipped
// artifact - is byte-identical to what it was: no maps emitted, nothing referenced, no size cost.
const coverageSourcemap = process.env.OFFGRID_E2E_COVERAGE ? ('inline' as const) : false
const rendererStyleNonce = randomBytes(18).toString('base64url')
const rendererContentSecurityPolicy = createRendererContentSecurityPolicy(rendererStyleNonce)

export default defineConfig({
  main: {
    define: proDefine,
    build: {
      sourcemap: coverageSourcemap,
      rollupOptions: {
        // The TTS worker must live inside app.asar beside its JavaScript
        // dependencies. Copying the raw source into Resources makes ESM resolve
        // from that external directory, where kokoro-js does not exist.
        input: {
          index: resolve('src/main/index.ts'),
          'tts-worker': resolve('resources/tts-worker.mjs')
        }
      }
    },
    // Deps are externalized by default (resolved from node_modules at runtime).
    // @scure/bip39 + @noble/hashes are ESM-only ("type":"module"); a CJS main
    // process require()-ing them throws ERR_REQUIRE_ESM at runtime. Exclude them
    // from externalization so Rollup BUNDLES them into the main chunk (transpiled
    // to the output format), sidestepping the ESM/CJS boundary. Used by the pro
    // vault recovery-phrase feature (pro/main/vault/vault-recovery.ts).
    plugins: [
      externalizeDepsPlugin({
        // Kokoro owns Transformers v3 transitively. The worker imports its env
        // directly so cache configuration and Kokoro share one module instance;
        // keep that native Node package external instead of bundling browser shims.
        include: ['@huggingface/transformers'],
        exclude: ['@scure/bip39', '@noble/hashes']
      })
    ],
    resolve: {
      alias: {
        '@offgrid/core': resolve('src'),
        '@offgrid/pro/main': proMain
      }
    }
  },
  preload: {
    define: proDefine,
    build: { sourcemap: coverageSourcemap }
  },
  renderer: {
    define: proDefine,
    build: { sourcemap: coverageSourcemap },
    html: { cspNonce: rendererStyleNonce },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src'),
        '@offgrid/core': resolve('src'),
        '@offgrid/pro/renderer': proRenderer
      }
    },
    plugins: [
      {
        name: 'offgrid-renderer-csp',
        transformIndexHtml: {
          order: 'pre',
          handler: () => [
            {
              tag: 'meta',
              attrs: {
                'http-equiv': 'Content-Security-Policy',
                content: rendererContentSecurityPolicy
              },
              injectTo: 'head-prepend'
            }
          ]
        }
      },
      react(),
      tailwindcss()
    ]
  }
})
