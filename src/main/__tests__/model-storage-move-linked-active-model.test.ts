// Move model files: the person's active chat model must still be found after the move, also
// when it reaches the models folder through a link (a model shared with another app by a
// symbolic link, or a hard link made to save space). Real files in a temp profile.
import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { moveModelStorage } from '../model-storage-move'
import { configureRuntime } from '../runtime-env'
import { resolveModelReference } from '../model-paths'

const roots: string[] = []
afterEach(() => {
  configureRuntime({ modelsDir: undefined, dataDir: undefined })
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function profileWithActiveModel(link: 'symbolic' | 'hard'): {
  profile: string
  source: string
  destination: string
} {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'og-model-move-link-')))
  roots.push(root)
  const profile = path.join(root, 'profile')
  const source = path.join(profile, 'models')
  const destination = path.join(root, 'destination')
  const otherApp = path.join(root, 'other-app-models')
  fs.mkdirSync(source, { recursive: true })
  fs.mkdirSync(destination)
  fs.mkdirSync(otherApp)
  configureRuntime({ dataDir: profile, modelsDir: source })
  // The weights live with another app; the models folder links to them.
  const shared = path.join(otherApp, 'shared-chat-model.gguf')
  fs.writeFileSync(shared, 'weights')
  const linked = path.join(source, 'shared-chat-model.gguf')
  if (link === 'symbolic') fs.symlinkSync(shared, linked)
  else fs.linkSync(shared, linked)
  fs.writeFileSync(
    path.join(source, 'active-model.json'),
    JSON.stringify({ primary: 'shared-chat-model.gguf' })
  )
  return { profile, source, destination }
}

describe('Move model files with a linked active model', () => {
  for (const link of ['symbolic', 'hard'] as const) {
    it(`still finds the active chat model after the move (${link} link)`, async () => {
      const f = profileWithActiveModel(link)
      // The chat engine resolves its model this way (llm.ts resolveModel).
      const before = resolveModelReference('shared-chat-model.gguf')
      expect(fs.existsSync(before), 'found before the move').toBe(true)

      await moveModelStorage(f.profile, f.source, f.destination, { ownedFiles: [] })

      const active = JSON.parse(
        fs.readFileSync(path.join(f.destination, 'active-model.json'), 'utf8')
      ) as { primary: string }
      expect(active.primary).toBe('shared-chat-model.gguf')
      const resolved = resolveModelReference(active.primary)
      expect(fs.existsSync(resolved), 'found after the move').toBe(true)
    })
  }
})
