// The translation preview build: the renderer's own Vite config (electron.vite.config.ts), as a plain web
// page with the demo bridge (src/renderer/src/preview). `npm run build:preview` writes out/preview/, which
// the translate editor serves at /desktop/.
import { resolve } from 'path'
import { cpSync, existsSync } from 'fs'
import { defineConfig, type Plugin, type UserConfig } from 'vite'
import electronConfig from './electron.vite.config'

const renderer = (electronConfig as { renderer: UserConfig }).renderer
const outDir = resolve('out/preview')
const catalogs = resolve('node_modules/@offgrid/i18n/catalogs')

// The catalogs ship beside the page, so ?lang= works without the editor.
const copyCatalogs: Plugin = {
  name: 'offgrid-preview-catalogs',
  closeBundle() {
    if (existsSync(catalogs)) cpSync(catalogs, resolve(outDir, 'catalogs'), { recursive: true })
  }
}

export default defineConfig({
  ...renderer,
  root: resolve('src/renderer'),
  base: './',
  plugins: [...(renderer.plugins ?? []), copyCatalogs],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: { input: resolve('src/renderer/preview.html') }
  }
})
