import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeDownloadBridge } from '@offgrid/models/node'
import { nodeDownloadBridge } from '../node-download-bridge'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

describe('Desktop Node download bridge composition', () => {
  it('creates the real Shared bridge over the Desktop model directory', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-download-bridge-'))
    temporaryDirectories.push(root)
    const modelsDirectory = path.join(root, 'models')

    const bridge = nodeDownloadBridge(modelsDirectory)
    const artifactPath = bridge.pathFor('assistant.gguf')

    expect(bridge).toBeInstanceOf(NodeDownloadBridge)
    expect(fs.statSync(modelsDirectory).isDirectory()).toBe(true)
    expect(artifactPath).toBe(path.join(modelsDirectory, 'assistant.gguf'))
    expect(await bridge.exists(artifactPath)).toBe(false)

    fs.writeFileSync(artifactPath, 'model-bytes')

    expect(await bridge.exists(artifactPath, 11)).toBe(true)
    expect(await bridge.exists(artifactPath, 12)).toBe(false)
  })
})
