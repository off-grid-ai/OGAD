import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CATALOG } from '@offgrid/models'
import {
  backendOf,
  channelOf,
  contextBucket,
  documentFileType,
  documentSizeBucket,
  downloadErrorCode,
  gb,
  generationErrorCode,
  languageOf,
  osVersionOf,
  platformOf,
  quantOf,
  roundMs,
  roundRate,
  sizeBucket
} from '../properties'
import { scrubException, scrubText } from '../scrub'
import { modelRef } from '../model-ref'
import { problemMailto, readProblemLog, REPORT_LOG_MAX_CHARS } from '../report-problem'
import { isAnalyticsSettingKey } from '../../../shared/analytics'

// The value rules in docs/ANALYTICS.md, checked against the spec's own examples.

const GiB = 1024 ** 3

describe('shared value rules', () => {
  it('buckets model sizes, document sizes and context lengths', () => {
    expect([0.5, 1.5, 3, 6, 9].map((g) => sizeBucket(g * GiB))).toEqual([
      '<1GB',
      '1-2GB',
      '2-4GB',
      '4-8GB',
      '>8GB'
    ])
    expect([1e5, 5e6, 5e7, 5e8].map(documentSizeBucket)).toEqual([
      '<1MB',
      '1-10MB',
      '10-100MB',
      '>100MB'
    ])
    expect([100, 4_000, 16_000, 64_000].map(contextBucket)).toEqual([
      '<2k',
      '2-8k',
      '8-32k',
      '>32k'
    ])
  })

  it('rounds durations to whole ms and rates to one decimal', () => {
    expect(roundMs(12.6)).toBe(13)
    expect(roundMs(-3)).toBe(0)
    expect(roundRate(41.27)).toBe(41.3)
    expect(gb(17_179_869_184)).toBe(17)
  })

  it('maps reported accelerators to cpu, gpu, npu or remote', () => {
    expect(
      [
        'Metal',
        'CUDA',
        'Vulkan + CPU',
        'CPU',
        'Core ML',
        'Remote',
        'DirectML',
        'wasm',
        'mystery',
        undefined
      ].map(backendOf)
    ).toEqual(['gpu', 'gpu', 'gpu', 'cpu', 'npu', 'remote', 'gpu', 'cpu', null, null])
  })

  it('reads the quantization from a file name', () => {
    expect(quantOf('Qwen3.5-2B-Q4_K_M.gguf')).toBe('Q4_K_M')
    expect(quantOf('model-iq3_xs.gguf')).toBe('IQ3_XS')
    expect(quantOf('model-f16.gguf')).toBe('F16')
    expect(quantOf('weights.bin')).toBeNull()
    expect(quantOf(undefined)).toBeNull()
  })

  it('describes the machine in the spec values', () => {
    expect(['darwin', 'win32', 'linux'].map(platformOf)).toEqual(['macos', 'windows', 'linux'])
    expect(osVersionOf('macos', '15.5.1')).toBe('15.5')
    expect(osVersionOf('windows', '10.0.22631.1')).toBe('10.0.22631')
    expect(languageOf('en-US')).toBe('en')
    expect(languageOf('pt_BR')).toBe('pt')
    expect(languageOf('')).toBe('unknown')
    expect(channelOf('0.0.55')).toBe('stable')
    expect(channelOf('0.0.117-beta.1')).toBe('nightly')
  })

  it('turns failures into fixed codes, never the message', () => {
    expect(
      [
        'download interrupted',
        'ENOSPC: no space left',
        'sha256 mismatch',
        'HTTP 401 Unauthorized',
        'HTTP 404',
        'HTTP 503',
        'fetch failed',
        'weird',
        undefined
      ].map(downloadErrorCode)
    ).toEqual([
      'interrupted',
      'storage',
      'integrity',
      'http_auth',
      'http_not_found',
      'http_server',
      'network',
      'unknown',
      'unknown'
    ])
    expect(
      [
        new Error('CUDA out of memory'),
        new Error('request timed out'),
        new Error('Models not downloaded'),
        new Error('LLM Service not ready'),
        new Error('prompt exceeds the context'),
        'something else'
      ].map(generationErrorCode)
    ).toEqual([
      'out_of_memory',
      'timeout',
      'model_missing',
      'engine_unavailable',
      'context_exceeded',
      'generation_failed'
    ])
  })

  it('knows its own settings keys', () => {
    expect(isAnalyticsSettingKey('analyticsUsage')).toBe(true)
    expect(isAnalyticsSettingKey('toolsEnabled')).toBe(false)
  })
})

describe('model names', () => {
  const entry = CATALOG.find((model) => model.files.length > 0)!

  it('sends a catalog ID for a catalog model, by ID or by its file on disk', () => {
    expect(modelRef(entry.id).model).toBe(entry.id)
    expect(modelRef(`/Users/alice/models/${entry.files[0]!.name}`).model).toBe(entry.id)
    expect(modelRef(`C:\\Users\\alice\\${entry.files[0]!.name}`).model).toBe(entry.id)
  })

  it('sends a public repo only for a download, and custom for anything else', () => {
    expect(modelRef('someone/Some-Model-GGUF', true).model).toBe('someone/Some-Model-GGUF')
    expect(modelRef('someone/Some-Model-GGUF').model).toBe('custom')
    expect(modelRef('/Users/alice/Private-Q4_K_M.gguf')).toEqual({
      model: 'custom',
      quant: 'Q4_K_M'
    })
    expect(modelRef('../../etc', true).model).toBe('custom')
    expect(modelRef(undefined).model).toBe('custom')
  })
})

describe('document type', () => {
  it('sends an extension the app opens, and never a private suffix', () => {
    expect(documentFileType('Q3 plan.PDF')).toBe('pdf')
    expect(documentFileType('notes.clientsecret')).toBe('other')
    expect(documentFileType('README')).toBe('none')
  })
})

describe('crash scrubbing', () => {
  it('keeps file names, lines and functions, and drops paths, quotes, hosts and people', () => {
    const error = new TypeError(
      `Cannot read "secret prompt" from /Users/alice/Documents/plan.pdf at https://example.com/x for bob@example.com via 192.168.1.5:8080 and api.openai.com`
    )
    error.stack = [
      `TypeError: ${error.message}`,
      '    at readPlan (/Users/alice/app/out/main/index.js:120:7)',
      '    at C:\\Users\\alice\\app\\out\\main\\index.js:9:3',
      '    at node:internal/process/task_queues:95:5',
      '    at Object.<anonymous> (file:///Users/alice/node_modules/pkg/index.js:1:1)',
      '    not a frame'
    ].join('\n')
    const scrubbed = scrubException(error)
    const text = JSON.stringify(scrubbed)
    for (const leaked of [
      'alice',
      'secret prompt',
      'example.com',
      'bob@',
      '192.168',
      'openai.com',
      'Documents',
      'plan.pdf'
    ])
      expect(text).not.toContain(leaked)
    expect(scrubbed.type).toBe('TypeError')
    expect(scrubbed.value).toContain('from <file>')
    expect(scrubbed.frames).toEqual([
      { filename: 'index.js', function: 'readPlan', lineno: 120, colno: 7, in_app: true },
      { filename: 'index.js', function: '<anonymous>', lineno: 9, colno: 3, in_app: true },
      { filename: 'task_queues', function: '<anonymous>', lineno: 95, colno: 5, in_app: false },
      { filename: 'index.js', function: 'Object.<anonymous>', lineno: 1, colno: 1, in_app: false }
    ])
  })

  it('drops the home folder, the account name and bare file names a person owns', () => {
    const home = os.homedir()
    const user = os.userInfo().username
    const value = scrubText(
      `ENOENT ${home}/My Documents/Q3 plan.pdf, C:\\Users\\${user} Smith\\notes.txt, owner ${user}, open budget.xlsx and llama-3-8b.Q4_K_M.gguf`
    )
    for (const leaked of [home, 'Documents', 'plan', 'notes', 'budget', 'llama'])
      expect(value).not.toContain(leaked)
    expect(value).not.toContain(`${user} Smith`)
    expect(value).toContain('owner <user>,')
  })

  it('bounds hostile input: a huge message scrubs fast and a quote cut open still goes', () => {
    const started = Date.now()
    const value = scrubText(`fail "${'secret '.repeat(1_000)}" ${'a.'.repeat(50_000)}`)
    expect(Date.now() - started).toBeLessThan(500)
    expect(value).not.toContain('secret')
    // Cutting one kind of quote can open another: every kind is closed before the patterns run.
    const mixed = scrubText(`x "leak \`zzz" ${'y'.repeat(2_000)}`)
    expect(mixed).not.toContain('leak')
    expect(
      scrubException({ name: 'Error', message: 'x', stack: `at ${'/'.repeat(20_000)}:1:1` }).frames
    ).toEqual([])
  })

  it('scrubs anything thrown, not only errors', () => {
    expect(scrubException('plain /home/bob/x.txt').value).toBe('plain <file>')
    expect(scrubException('at /app/out/main/index.js').value).toBe('at index.js')
    expect(scrubException({ name: 'bad name!', message: 42 })).toEqual({
      type: 'Error',
      value: '',
      frames: []
    })
    expect(scrubText('a\n\tb')).toBe('a b')
  })
})

describe('report a problem', () => {
  it('reads the newest whole lines of the log', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'og-log-'))
    const file = path.join(dir, 'app.log')
    expect(await readProblemLog(file)).toEqual({ path: file, text: '', truncated: false })
    writeFileSync(file, 'line one\nline two\n')
    expect(await readProblemLog(file)).toMatchObject({
      text: 'line one\nline two\n',
      truncated: false
    })
    writeFileSync(file, `${'x'.repeat(REPORT_LOG_MAX_CHARS)}\nlast line\n`)
    const long = await readProblemLog(file)
    expect(long.truncated).toBe(true)
    expect(long.text).toBe('last line\n')
  })

  it('opens an e-mail to support that asks for the pasted log', () => {
    const link = problemMailto('0.0.55', 'macos')
    expect(link.startsWith('mailto:support@getoffgridai.co?subject=')).toBe(true)
    const body = decodeURIComponent(link.split('&body=')[1]!)
    expect(body).toContain('Version: 0.0.55 (macos)')
    expect(body).toContain('Paste the log')
  })
})
