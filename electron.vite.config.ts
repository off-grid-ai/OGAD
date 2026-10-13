import { resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createRendererContentSecurityPolicy } from './src/shared/renderer-csp'
import {
  checkOauthBuildConfig,
  readUserBuildEnv,
  resolveOauthBuildConfig
} from './scripts/oauth-build-config.mjs'

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
// The app's own version. An unpackaged launch that points Electron at a script rather than this
// package (the e2e capture fixtures) gets Electron's version from app.getVersion().
const appVersion = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string })
  .version
// App registrations for Connect with Off Grid AI (scripts/oauth-build-config.mjs). Only a Desktop
// Google registration is accepted: a Web application's confidential secret must not enter an
// installed app. A release build (OFFGRID_REQUIRE_OAUTH=1) fails rather than ship without them.
const oauth = resolveOauthBuildConfig([
  process.env,
  loadEnv('production', process.cwd(), ['GOOGLE_', 'MICROSOFT_']),
  readUserBuildEnv()
])
checkOauthBuildConfig(oauth, { pro: proExists, require: process.env.OFFGRID_REQUIRE_OAUTH === '1' })
const microsoftClientId = oauth.microsoftClientId
const googleClientId = oauth.google.clientId
const googleClientSecret = oauth.google.clientSecret

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
    define: {
      ...proDefine,
      __OFFGRID_APP_VERSION__: JSON.stringify(appVersion),
      __OFFGRID_MICROSOFT_CLIENT_ID__: JSON.stringify(microsoftClientId),
      __OFFGRID_GOOGLE_CLIENT_ID__: JSON.stringify(googleClientId),
      __OFFGRID_GOOGLE_CLIENT_SECRET__: JSON.stringify(googleClientSecret)
    },
    build: {
      sourcemap: coverageSourcemap,
      // The embedding worker is a SECOND main-process entry, bundled beside index.js so
      // embeddings.ts can spawn it by path. It must not be folded into the main chunk: the point
      // is that native ONNX inference runs off the thread that owns the window.
      rollupOptions: {
        // Rollup hoists external require() calls above source imports. The CUDA
        // pack must be selected before its first ONNX Runtime import, including
        // in the embedding and speech workers.
        output: {
          banner: readFileSync(resolve('scripts/windows-onnx-cuda-preload.cjs'), 'utf8')
        },
        input: {
          index: resolve('src/main/index.ts'),
          'embeddings-worker': resolve('src/main/embeddings-worker.ts'),
          'tts-onnx-worker': resolve('src/main/tts-onnx-worker.ts')
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
        exclude: ['@scure/bip39', '@noble/hashes', '@offgrid/executorch-speech']
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
    build: {
      sourcemap: coverageSourcemap,
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          ...(proExists
            ? { 'meeting-recorder': resolve('pro/main/meeting-recorder-preload.ts') }
            : {})
        }
      }
    }
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
