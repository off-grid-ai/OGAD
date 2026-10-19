import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'

// Opt-in, real local inference. Standard CI uses ai-activity.spec.ts instead.
test('records real local requests for all five AI modalities', async ({ playwright }, testInfo) => {
  test.skip(!process.env.OFFGRID_AI_ACTIVITY_MODELS, 'Requires installed local models')
  test.setTimeout(300_000)
  const source = process.env.OFFGRID_AI_ACTIVITY_MODELS!
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-ai-activity-live-'))
  const models = path.join(profile, 'models')
  fs.mkdirSync(models)
  for (const name of [
    'Qwen3.5-0.8B-Q4_K_M.gguf',
    'dreamshaper-xl-v2-turbo-Q8_0.gguf',
    'ggml-base.bin'
  ]) {
    fs.copyFileSync(path.join(source, name), path.join(models, name), fs.constants.COPYFILE_FICLONE)
  }
  fs.cpSync(path.join(source, '.cache'), path.join(models, '.cache'), {
    recursive: true,
    mode: fs.constants.COPYFILE_FICLONE
  })
  fs.writeFileSync(
    path.join(models, 'active-model.json'),
    JSON.stringify({ id: 'Qwen3.5-0.8B', primary: 'Qwen3.5-0.8B-Q4_K_M.gguf' })
  )
  fs.writeFileSync(
    path.join(models, 'active-modalities.json'),
    JSON.stringify({ image: 'dreamshaper-xl-v2-turbo-Q8_0.gguf', transcription: 'ggml-base.bin' })
  )
  // Refuse to connect to a personal app's gateway or model process.
  for (const port of [7878, 8439]) {
    await new Promise<void>((resolve, reject) => {
      const probe = net
        .createServer()
        .once('error', reject)
        .listen(port, '127.0.0.1', () => probe.close(() => resolve()))
    })
  }
  const app = await playwright._electron.launch({
    args: [process.env.OFFGRID_AI_ACTIVITY_APP ?? '.'],
    env: {
      ...process.env,
      OFFGRID_USER_DATA: profile,
      OFFGRID_E2E_ISOLATED_INSTANCE: '1',
      OFFGRID_E2E_HEADLESS: '1',
      OFFGRID_PRO: '0',
      OFFGRID_SEED: ''
    }
  })
  const output: string[] = []
  app.process().stdout?.on('data', (data) => output.push(String(data)))
  app.process().stderr?.on('data', (data) => output.push(String(data)))
  try {
    const page = await app.firstWindow()
    page.on('close', () => output.push('\n[test] renderer closed\n'))
    page.on('crash', () => output.push('\n[test] renderer crashed\n'))
    await page.waitForFunction(() => !!window.api?.aiLogsList)
    await expect
      .poll(async () =>
        fetch('http://127.0.0.1:7878/v1/models')
          .then((r) => r.status)
          .catch(() => 0)
      )
      .toBe(200)
    await expect
      .poll(async () => page.evaluate(async () => (await window.api.chatHealth()).status), {
        timeout: 90_000
      })
      .toMatch(/^(ready|idle)$/)
    async function post(route: string, body: unknown): Promise<Response> {
      const response = await fetch(`http://127.0.0.1:7878${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000)
      })
      expect(response.status, await response.clone().text()).toBe(200)
      return response
    }
    await post('/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
      max_tokens: 24
    })
    const speech = await post('/v1/audio/speech', {
      input: 'This is a local request log test.',
      voice: 'af_heart',
      response_format: 'json'
    })
    const { audio } = (await speech.json()) as { audio: string }
    const form = new FormData()
    form.append(
      'file',
      new Blob([Buffer.from(audio.split(',')[1]!, 'base64')], { type: 'audio/wav' }),
      'sample.wav'
    )
    const transcription = await fetch('http://127.0.0.1:7878/v1/audio/transcriptions', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000)
    })
    expect(transcription.status, await transcription.text()).toBe(200)
    await post('/v1/embeddings', { input: 'Local request log verification.' })
    await post('/v1/images/generations', {
      prompt: 'A plain red circle on white paper',
      size: '256x256',
      steps: 1,
      enhancePrompt: false
    })
    const windowPromise = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0]!
      return main.webContents.executeJavaScript('window.api.aiLogsOpenWindow()')
    })
    const activity = await windowPromise
    await expect
      .poll(async () => {
        const logs = await activity.evaluate(() => window.api.aiLogsList({ limit: 100 }))
        return [
          ...new Set(
            logs.rows.filter((row) => row.status === 'completed').map((row) => row.modality)
          )
        ].sort()
      })
      .toEqual(['embedding', 'image', 'stt', 'text', 'tts'])
    const logs = await activity.evaluate(() => window.api.aiLogsList({ limit: 100 }))
    await testInfo.attach('real-request-summaries', {
      body: JSON.stringify(logs, null, 2),
      contentType: 'application/json'
    })
    for (const modality of ['text', 'image', 'tts', 'stt', 'embedding']) {
      const row = logs.rows.find(
        (item) => item.modality === modality && item.status === 'completed'
      )!
      const detail = await activity.evaluate((id) => window.api.aiLogsDetail(id), row.id)
      expect(detail?.response).toBeDefined()
    }
  } finally {
    await testInfo.attach('runtime-log', { body: output.join(''), contentType: 'text/plain' })
    fs.writeFileSync(testInfo.outputPath('runtime.log'), output.join(''))
    await app.close()
    fs.rmSync(profile, { recursive: true, force: true })
  }
})
