/**
 * Tool routing with the real MiniLM, on the requests people actually sent. The fake embedding in
 * tool-embedding-ranking.test.ts proves the ranking code; only the real model shows what a message
 * routes to. Runs where the model is on disk: point OFFGRID_ROUTING_MODEL_DIR at a folder holding
 * Xenova/all-MiniLM-L6-v2 (the app's models folder, or its .cache parent).
 */
import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false, getAppPath: () => process.cwd() },
  safeStorage: {},
  shell: {},
  ipcMain: { handle() {}, on() {} },
  BrowserWindow: { getAllWindows: () => [] }
}))

import { enabledToolSchemas } from '../../tools'
import { contextualToolRoutingText, selectRelevantToolsSemantic } from '../tool-embedding-ranking'
import { embedTexts } from '../../embeddings-core'
import { resolveTransformersPackage } from '../../model-paths'

const MODEL = 'Xenova/all-MiniLM-L6-v2'
const root = process.env.OFFGRID_ROUTING_MODEL_DIR
const onDisk = !!root && !!resolveTransformersPackage(MODEL, 'model.onnx', [path.resolve(root)])

async function routedTo(request: string): Promise<string[]> {
  const dir = path.resolve(root!)
  const embed = async (text: string): Promise<number[]> =>
    (await embedTexts([text], MODEL, dir, undefined, ['cpu'], [dir]))[0]!
  const tools = (await enabledToolSchemas([])).map((tool) => tool.schema)
  const picked = await selectRelevantToolsSemantic(
    contextualToolRoutingText(request, []),
    tools,
    { embed },
    request
  )
  return picked.map((tool) => (tool as { function: { name: string } }).function.name)
}

describe.skipIf(!onDisk)('tool routing with the real model', () => {
  it('offers no web tool to a request that rules the web out', async () => {
    expect(
      await routedTo(
        'Extract the handwritten Spanish text from the attached image. Do not attempt to access the web.'
      )
    ).toEqual([])
    expect(
      await routedTo('Translate this photo of a menu into English. No internet please.')
    ).toEqual([])
  }, 60_000)

  it('offers read_url to a request to read a web address', async () => {
    expect(await routedTo('Read https://en.wikipedia.org/wiki/Rome and summarise it')).toContain(
      'read_url'
    )
    expect(await routedTo('what does this page say? https://stripe.com/pricing')).toContain(
      'read_url'
    )
    expect(await routedTo('Fetch the text of https://example.org')).toContain('read_url')
  }, 60_000)
})
