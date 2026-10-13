// The model server, downloads, runtime processes, and request routing are real.
// Only Hugging Face and the native inference executable use contract fakes.
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash } from 'node:crypto'

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ogad-specialist-api-'))
vi.mock('electron', () => ({
  app: { getPath: () => directory, getAppPath: () => process.cwd(), isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false }
}))
import { startModelServer, stopModelServer } from '../model-server'
import {
  downloadModel,
  listInstalled,
  DECIDER_2B,
  getActiveModel,
  desktopCatalog,
  registerTransferredModel
} from '../models-manager'
import { decisionRuntime } from '../accessibility/decision-runtime'
import { grounderRuntime } from '../vision/grounder-runtime'
import { llm } from '../llm'
import { activateModel, KEV_4B_ID } from '../models-manager'
import { getComputerUseSettings, setComputerUseSettings } from '../computer-use-settings'
import { getWebUseSettings, setWebUseSettings } from '../web-use-settings'

const grounder = 'bartowski/tencent_UI-Mate-27B-GGUF'
const chat = 'HuggingFaceTB/SmolLM2-135M-Instruct-GGUF'
const nativeFetch = globalThis.fetch
const previousBin = process.env.OFFGRID_BIN_DIR
let endpoint: string
const weight = Buffer.alloc(2048)
weight.write('GGUF')
const digest = createHash('sha256').update(weight).digest('hex')

beforeAll(async () => {
  const bin = path.join(directory, 'bin', process.platform === 'linux' ? 'llama-cpu' : 'llama')
  fs.mkdirSync(bin, { recursive: true })
  fs.writeFileSync(
    path.join(bin, 'llama-server'),
    `#!/usr/bin/env node
const http = require('node:http');
const args = process.argv.slice(2), port = Number(args[args.indexOf('--port')+1]);
const server = http.createServer(async (req,res) => {
  res.setHeader('Content-Type','application/json');
  if(req.url==='/health') return res.end('{"status":"ok"}');
  if(req.url==='/props') return res.end('{}');
  if(req.url==='/v1/models') return res.end('{"data":[{"id":"fixture-chat"}]}');
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=JSON.parse(raw||'{}');
  if(req.url==='/completion') return res.end(JSON.stringify({completion_probabilities:[{top_probs:[{token:'A',prob:0.8},{token:'B',prob:0.2}]}]}));
  if(req.url==='/v1/chat/completions') {
    if(body.stream) {res.setHeader('Content-Type','text/event-stream');return res.end('data: '+JSON.stringify({choices:[{delta:{content:'fixture answer'}}]})+'\\n\\ndata: [DONE]\\n\\n');}
    return res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'fixture answer'}}]}));
  }
  res.statusCode=404;res.end('{}');
});
server.listen(port,'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`
  )
  fs.chmodSync(path.join(bin, 'llama-server'), 0o755)
  process.env.OFFGRID_BIN_DIR = path.dirname(bin)
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    if (url.hostname !== 'huggingface.co') return nativeFetch(input, init)
    if (url.pathname.startsWith('/api/models/')) {
      return Response.json({
        siblings: [
          {
            rfilename: 'fixture-Q4_K_M-00001-of-00002.gguf',
            lfs: { oid: digest, size: weight.length }
          },
          {
            rfilename: 'fixture-Q4_K_M-00002-of-00002.gguf',
            lfs: { oid: digest, size: weight.length }
          },
          { rfilename: 'mmproj-F16.gguf', size: weight.length }
        ]
      })
    }
    return new Response(weight, { headers: { 'content-length': String(weight.length) } })
  })
  const probe = http.createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as { port: number }).port
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  endpoint = `http://127.0.0.1:${port}`
  startModelServer(port)
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${endpoint}/v1`)).ok) return
    } catch {
      /* wait for listen */
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Model gateway did not start')
})

afterAll(async () => {
  stopModelServer()
  await decisionRuntime.shutdown()
  await grounderRuntime.shutdown()
  llm.stop()
  vi.unstubAllGlobals()
  if (previousBin === undefined) delete process.env.OFFGRID_BIN_DIR
  else process.env.OFFGRID_BIN_DIR = previousBin
  fs.rmSync(directory, { recursive: true, force: true })
})

async function request(model: string, messages: unknown[], extra = {}): Promise<Response> {
  return fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, ...extra })
  })
}
async function completed(
  response: Response
): Promise<{ model: string; choices: Array<{ message: { content: string } }> }> {
  expect(response.status).toBe(202)
  const queued = await response.json()
  for (let attempt = 0; attempt < 100; attempt++) {
    const poll = await fetch(`${endpoint}/v1/requests/${queued.request_id}`)
    const body = await poll.json()
    if (body.status === 'failed') throw new Error(JSON.stringify(body))
    if (body.status === 'completed') return body.result
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('Async model request did not finish')
}

it('downloads complete shards and serves decision, grounding, and selected chat models', async () => {
  const messages = [
    {
      role: 'user',
      content:
        'Context:\nA menu is open.\nQuestion: What next?\nOptions:\n0: Select the item\n1: Close the menu'
    }
  ]
  expect((await request(DECIDER_2B.id, messages)).status).toBe(404)
  // A verified device transfer supplies these small native-boundary fixtures.
  // Register through the same public import boundary used after a transfer.
  for (const id of [DECIDER_2B.id, grounder]) {
    const entry = (await desktopCatalog()).find((model) => model.id === id)!
    const files = entry.files.map((file) => {
      const target = path.join(llm.getModelsDir(), file.name)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, weight)
      return { name: file.name, sizeBytes: weight.length, sha256: digest }
    })
    expect(
      await registerTransferredModel({
        id,
        name: entry.name,
        kind: entry.kind,
        source: 'catalog',
        files: [files[0]!, ...files.slice(1)]
      })
    ).toMatchObject({ success: true })
  }
  expect(await downloadModel(chat, undefined, 'fixture-Q4_K_M-00002-of-00002.gguf')).toEqual({
    success: true
  })
  expect(await listInstalled()).toEqual(expect.arrayContaining([DECIDER_2B.id, grounder, chat]))
  const inventory = await (await fetch(`${endpoint}/v1/models`)).json()
  expect(inventory.data).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: DECIDER_2B.id }),
      expect.objectContaining({ id: grounder }),
      expect.objectContaining({ id: chat })
    ])
  )
  expect(
    (await request(DECIDER_2B.id, [{ role: 'user', content: 'No options supplied' }])).status
  ).toBe(400)
  const decision = await request(DECIDER_2B.id, messages)
  expect(decision.status).toBe(200)
  expect(JSON.parse((await decision.json()).choices[0]!.message.content)).toMatchObject({
    choice: 0,
    confidence: 0.8
  })
  const stream = await request(DECIDER_2B.id, messages, { stream: true })
  expect(stream.headers.get('content-type')).toContain('text/event-stream')
  expect(await stream.text()).toContain('[DONE]')
  const asyncDecision = await completed(await request(DECIDER_2B.id, messages, { async: true }))
  expect(asyncDecision.model).toBe(DECIDER_2B.id)
  const grounding = [{ role: 'user', content: 'Find the menu item.' }]
  expect((await (await request(grounder, grounding)).json()).choices[0]!.message.content).toBe(
    'fixture answer'
  )
  expect(
    (await completed(await request(grounder, grounding, { async: true }))).choices[0]!.message
      .content
  ).toBe('fixture answer')
  const chatResponse = await request(chat, [{ role: 'user', content: 'Hi' }], { stream: true })
  expect(await chatResponse.text()).toContain('fixture answer')
  const asyncChat = await completed(
    await request(chat, [{ role: 'user', content: 'Hi' }], { async: true })
  )
  expect(asyncChat.choices[0]!.message.content).toBe('fixture answer')
  expect(getActiveModel()).toBe(chat)
}, 30_000)

it.each([
  ['same_as_chat', 'decision_plus_reasoning'],
  ['separate_specialist', 'decision_plus_specialist'],
  ['text_plus_specialist', 'decision_plus_specialist'],
  ['decision_plus_specialist', 'decision_plus_specialist'],
  ['decision_plus_reasoning', 'decision_plus_reasoning']
])('Use Kev enables decisions from %s and preserves grounding', async (before, after) => {
  setComputerUseSettings({ modelStrategy: before, groundingModelId: grounder, context: '16k' })
  setWebUseSettings({ modelStrategy: before, groundingModelId: grounder, context: '32k' })
  expect(await activateModel(KEV_4B_ID, 'computer_use')).toEqual({ success: true })
  expect(getComputerUseSettings()).toMatchObject({
    modelStrategy: after,
    decisionModelId: KEV_4B_ID,
    groundingModelId: grounder,
    context: '16k'
  })
  expect(getWebUseSettings()).toMatchObject({
    modelStrategy: after,
    decisionModelId: KEV_4B_ID,
    groundingModelId: grounder,
    context: '32k'
  })
})
