/**
 * Answer-quality evals on the real desktop app, with real models and no mocks.
 *
 *   arch -arm64 node scripts/eval/run.ts [--suites brain,tools,documents,chat,computer-use]
 *     [--model <catalog id>] [--adapter none] [--limit N] [--judge-url URL] [--judge-gguf PATH]
 *     [--computer-use-fixtures a.json,b.json] [--keep-profile]
 *
 * 1. Launch the dev build (out/) on a fresh plaintext profile so it builds its schema; close it.
 * 2. Seed shared/eval/profile.json into it (seed.ts). Never touches a real profile.
 * 3. Launch again, download (once, into ~/.cache/offgrid-eval/models) and activate the model —
 *    the app's own recommendation for this machine unless --model says otherwise — and wait for
 *    the records engine to embed the seeded rows.
 * 4. Run each case through window.api.toolChat, the same call the chat screen makes; Brain also
 *    runs window.api.universalSearch for recall@10. Turns and prompt tokens come from the app's
 *    AI request log.
 * 5. Close the app, grade exact-match cases, send open ones to the judge
 *    (scripts/action-data/e2e/judge.py --eval), and write the scorecard to shared/eval/scorecards.
 *
 * Side-effect tools (calendar, mail, messages, contacts, reminders, location, screen and browser
 * control, scheduling, media generation) are turned off in the eval profile: they would reach
 * Ali's real accounts and devices. The scorecard lists them.
 */
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { launchOffGrid } from '../../e2e/helpers/launch.ts'
import { completeOnboarding } from '../../e2e/helpers/onboarding.ts'
import { seedProfile, type Profile } from './seed.ts'
import {
  argProblems,
  citedNumbers,
  devanagariChars,
  fillTemplates,
  missingGroups,
  type Case
} from './grade.ts'

const DESKTOP = path.resolve(import.meta.dirname, '..', '..')
const SHARED_EVAL = path.resolve(DESKTOP, '..', 'shared', 'eval')
const CACHE = process.env.OFFGRID_EVAL_CACHE ?? path.join(os.homedir(), '.cache', 'offgrid-eval')
const MODELS_DIR = process.env.OFFGRID_EVAL_MODELS ?? path.join(CACHE, 'models')
const CASE_SUITES = ['brain', 'tools', 'documents', 'chat'] as const
const SIDE_EFFECT_TOOLS = [
  'calendar_create_event',
  'calendar_list_events',
  'reminders_create',
  'reminders_list',
  'contacts_search',
  'messages_send',
  'mail_send',
  'open_url',
  'get_current_location',
  'web_use',
  'computer_use',
  'read_screen',
  'schedule_task',
  'cancel_scheduled_task',
  'generate_image',
  'generate_video',
  'make_film'
]

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const suites = (flag('suites') ?? [...CASE_SUITES, 'computer-use'].join(',')).split(',')
const limit = Number(flag('limit') ?? 0)
const adapter = flag('adapter') ?? 'none'
const judgeUrl = flag('judge-url') ?? 'http://127.0.0.1:8095/v1'
const judgeGguf = flag('judge-gguf')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const runDir = path.join(CACHE, 'runs', stamp)
fs.mkdirSync(runDir, { recursive: true })
fs.mkdirSync(MODELS_DIR, { recursive: true })

const log = (...parts: unknown[]): void =>
  console.log(`[eval ${new Date().toISOString().slice(11, 19)}]`, ...parts)
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T

// --- The app ------------------------------------------------------------------------------------

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-eval-'))
const env = {
  OFFGRID_USER_DATA: profileDir,
  OFFGRID_MODELS_DIR: MODELS_DIR,
  OFFGRID_PRO: '1',
  OFFGRID_E2E_HEADLESS: '1',
  NODE_ENV: 'production',
  NO_PROXY: '127.0.0.1,localhost'
}

async function open(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchOffGrid({ env })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await completeOnboarding(page)
  return { app, page }
}

/** window.api, typed loosely: this script reads only what it scores. */
type Api = Record<string, (...args: unknown[]) => Promise<unknown>> & {
  documents: Record<string, (...args: unknown[]) => unknown>
}
const call = <T>(page: Page, method: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    ([m, a]) => (window as unknown as { api: Api }).api[m as string]!(...(a as unknown[])),
    [method, args] as const
  ) as Promise<T>

interface TurnResult {
  answer: string
  toolCalls: { name: string; args: Record<string, unknown>; result: string; status: string }[]
  unified: { key: string; kind: string; title: string; snippet: string }[]
  toolsOffered?: string[]
  metrics?: { promptTokens?: number; estimatedPromptTokens?: number; modelName?: string }
}

async function ask(
  page: Page,
  q: string,
  opts: Record<string, unknown>
): Promise<{
  result?: TurnResult
  error?: string
  ms: number
  turns: number
  promptTokens: number
}> {
  const since = Date.now()
  const out = await page.evaluate(
    async ([question, options]) => {
      const api = (window as unknown as { api: Api }).api
      try {
        return { result: await api.toolChat!(question, [], options) }
      } catch (error) {
        return { error: String(error) }
      }
    },
    [q, opts] as const
  )
  const ms = Date.now() - since
  // Every model round of this turn is one text request in the AI request log.
  const rows = (
    (await call<{ rows: { id: string; startedAt: number; modality: string }[] }>(
      page,
      'aiLogsList',
      {
        since,
        modality: 'text',
        sort: 'oldest',
        limit: 100
      }
    )) ?? { rows: [] }
  ).rows.filter((row) => row.startedAt >= since)
  let promptTokens = 0
  for (const row of rows) {
    const detail = await call<{ metrics?: Record<string, unknown> } | null>(
      page,
      'aiLogsDetail',
      row.id
    )
    const m = detail?.metrics ?? {}
    promptTokens += Number(m.promptTokens ?? m.prompt_tokens ?? m.estimatedPromptTokens ?? 0) || 0
  }
  return {
    ...(out as { result?: TurnResult; error?: string }),
    ms,
    turns: rows.length,
    promptTokens
  }
}

// --- Suites ------------------------------------------------------------------------------------

interface Row {
  suite: string
  id: string
  q: string
  answer: string
  pass: boolean | null
  reasons: string[]
  judge?: string
  turns: number
  promptTokens: number
  ms: number
  recallAt10?: boolean
  cited?: boolean
  tools?: string[]
  sources?: string[]
  error?: string
}

const loadCases = (suite: string): { cases: Case[]; [k: string]: unknown } => {
  const file = readJson<{ cases: Case[]; [k: string]: unknown }>(
    path.join(SHARED_EVAL, 'cases', `${suite}.json`)
  )
  return { ...file, cases: limit ? file.cases.slice(0, limit) : file.cases }
}

/** Fixed parts of a case: groups, script, and (for refusals) nothing more. */
function exactReasons(c: Case, answer: string): string[] {
  const reasons = missingGroups(answer, fillTemplates(c.all)).map((g) => `missing ${g.join(' | ')}`)
  if (c.script === 'devanagari' && devanagariChars(answer) < 5) reasons.push('not in Devanagari')
  if (!answer.trim()) reasons.push('empty answer')
  return reasons
}

function row(
  suite: string,
  c: Case,
  turn: Awaited<ReturnType<typeof ask>>,
  extra: Partial<Row> = {}
): Row {
  const answer = turn.result?.answer ?? ''
  const reasons = turn.error ? [`error: ${turn.error}`] : exactReasons(c, answer)
  return {
    suite,
    id: c.id,
    q: c.q,
    answer,
    // Open cases wait for the judge; a case with a fixed part fails on it first.
    pass: reasons.length ? false : c.judge ? null : true,
    reasons,
    ...(c.judge ? { judge: c.judge } : {}),
    turns: turn.turns,
    promptTokens: turn.promptTokens,
    ms: turn.ms,
    tools: (turn.result?.toolCalls ?? []).map((t) => t.name),
    sources: (turn.result?.unified ?? []).map((s) => s.key),
    ...(turn.error ? { error: turn.error } : {}),
    ...extra
  }
}

async function brain(page: Page, keys: Record<string, string>): Promise<Row[]> {
  const rows: Row[] = []
  for (const c of loadCases('brain').cases) {
    const gold = new Set((c.gold ?? []).map((id) => keys[id]))
    const hits = await call<unknown>(page, 'universalSearch', c.q, { limit: 10, semantic: true })
    const list = (
      Array.isArray(hits) ? hits : ((hits as { results?: unknown[] })?.results ?? [])
    ) as { key?: string }[]
    const recallAt10 = list.slice(0, 10).some((hit) => gold.has(hit.key ?? ''))
    const turn = await ask(page, c.q, {
      conversationId: crypto.randomUUID(),
      allMemory: true,
      thinking: false
    })
    const unified = turn.result?.unified ?? []
    const cited = citedNumbers(turn.result?.answer ?? '').some((n) =>
      gold.has(unified[n - 1]?.key ?? '')
    )
    const r = row('brain', c, turn, { recallAt10 })
    r.cited = cited
    if (r.pass && !cited) {
      r.pass = false
      r.reasons.push('no citation of a gold source')
    }
    rows.push(r)
    log('brain', c.id, r.pass ? 'pass' : 'fail', recallAt10 ? 'r@10' : 'miss', r.reasons.join('; '))
  }
  return rows
}

async function tools(page: Page): Promise<Row[]> {
  const file = loadCases('tools')
  const schemas = file.schemas as Record<string, Record<string, string>>
  const rows: Row[] = []
  for (const c of file.cases) {
    const turn = await ask(page, c.q, {
      conversationId: crypto.randomUUID(),
      allMemory: !!c.memory,
      thinking: false
    })
    const r = row('tools', c, turn)
    const calls = turn.result?.toolCalls ?? []
    const expected = c.tools ?? []
    if (!turn.error) {
      if (!expected.length && calls.length)
        r.reasons.push(`called ${calls[0]!.name}, expected no tool`)
      if (expected.length && !expected.includes(calls[0]?.name ?? '')) {
        r.reasons.push(`first tool ${calls[0]?.name ?? 'none'}, expected ${expected.join(' or ')}`)
      }
      for (const t of calls) {
        for (const p of argProblems(t.args, schemas[t.name], c.args?.[t.name]))
          r.reasons.push(`${t.name}: ${p}`)
      }
      const seen = new Set<string>()
      for (const t of calls) {
        const sig = `${t.name}:${JSON.stringify(t.args)}`
        if (seen.has(sig)) r.reasons.push(`repeated ${t.name} with the same arguments`)
        seen.add(sig)
      }
      if (r.reasons.length) r.pass = false
    }
    rows.push(r)
    log(
      'tools',
      c.id,
      r.pass === null ? 'judge' : r.pass ? 'pass' : 'fail',
      r.tools?.join(','),
      r.reasons.join('; ')
    )
  }
  return rows
}

function cachedDocument(doc: { name: string; url: string; sha256: string }): string {
  const dir = path.join(CACHE, 'docs')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, doc.name)
  const hash = (): string => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (!fs.existsSync(file) || hash() !== doc.sha256) {
    const res = spawnSync('curl', ['-sSL', '-A', 'Mozilla/5.0', '-o', file, doc.url])
    if (res.status !== 0 || hash() !== doc.sha256)
      throw new Error(`${doc.name}: download failed or sha256 changed`)
  }
  return file
}

async function documents(page: Page): Promise<Row[]> {
  const file = loadCases('documents')
  const docs = file.documents as Record<string, { name: string; url: string; sha256: string }>
  const ready = new Map<string, { documentId?: string; name: string; kind: string; path: string }>()
  // A document that did not finish indexing: its cases fail instead of being asked without it.
  const notReady = new Map<string, string>()
  const rows: Row[] = []
  for (const c of file.cases) {
    const doc = docs[c.doc!]!
    let ref = ready.get(c.doc!)
    const unindexed = notReady.get(c.doc!)
    if (!ref && !unindexed) {
      const local = cachedDocument(doc)
      // Attach the file as the chat does, then wait for its indexing to finish (OCR included).
      const attached = await page.evaluate(
        async ([p, n]) => {
          const api = (window as unknown as { api: Api }).api
          const done = new Promise<string>((resolve) => {
            const off = api.documents.onProgress!(
              (progress: { name: string; phase: string; error?: string }) => {
                if (
                  progress.name === n &&
                  (progress.phase === 'ready' || progress.phase === 'failed')
                ) {
                  ;(off as () => void)()
                  resolve(progress.phase + (progress.error ? `: ${progress.error}` : ''))
                }
              }
            )
          })
          const res = (await api.processFilePath!(p, n)) as {
            documentId?: string
            kind: string
            path: string
          }
          const phase = await Promise.race([
            done,
            new Promise<string>((r) => setTimeout(() => r('no progress event'), 1_200_000))
          ])
          return { res, phase }
        },
        [local, doc.name] as const
      )
      log('documents', doc.name, attached.phase)
      if (attached.phase !== 'ready') notReady.set(c.doc!, attached.phase)
      else {
        ref = {
          documentId: attached.res.documentId,
          name: doc.name,
          kind: attached.res.kind,
          path: attached.res.path
        }
        ready.set(c.doc!, ref)
      }
    }
    if (!ref) {
      const reason = `document not indexed: ${notReady.get(c.doc!)}`
      rows.push({
        suite: 'documents',
        id: c.id,
        q: c.q,
        answer: '',
        pass: false,
        reasons: [reason],
        turns: 0,
        promptTokens: 0,
        ms: 0,
        error: reason
      })
      log('documents', c.id, 'fail', reason)
      continue
    }
    const turn = await ask(page, c.q, {
      conversationId: crypto.randomUUID(),
      allMemory: false,
      thinking: false,
      documents: [ref]
    })
    const r = row('documents', c, turn)
    rows.push(r)
    log(
      'documents',
      c.id,
      r.pass === null ? 'judge' : r.pass ? 'pass' : 'fail',
      r.reasons.join('; ')
    )
  }
  return rows
}

async function chat(page: Page): Promise<Row[]> {
  const rows: Row[] = []
  for (const c of loadCases('chat').cases) {
    const turn = await ask(page, c.q, {
      conversationId: crypto.randomUUID(),
      allMemory: false,
      thinking: false
    })
    const r = row('chat', c, turn)
    rows.push(r)
    log('chat', c.id, r.pass === null ? 'judge' : r.pass ? 'pass' : 'fail', r.reasons.join('; '))
  }
  return rows
}

// --- Judge -------------------------------------------------------------------------------------

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/models`, { signal: AbortSignal.timeout(5_000) })
    return res.ok
  } catch {
    return false
  }
}

/** The judge for open cases: the shared grader URL, or a local llama-server on --judge-gguf. */
async function judge(rows: Row[]): Promise<string> {
  const open = rows.filter((r) => r.pass === null)
  if (!open.length) return 'none needed'
  let url = judgeUrl
  let server: ReturnType<typeof spawn> | null = null
  let name = `${judgeUrl} (qwen38)`
  if (!(await reachable(url)) && judgeGguf) {
    const bin = path.join(DESKTOP, 'resources', 'bin', 'llama', 'llama-server')
    server = spawn(
      bin,
      ['-m', judgeGguf, '--port', '8096', '-c', '16384', '--jinja', '-ngl', '99'],
      {
        stdio: 'ignore'
      }
    )
    url = 'http://127.0.0.1:8096/v1'
    name = `local ${path.basename(judgeGguf)}`
    for (let i = 0; i < 180 && !(await reachable(url)); i++)
      await new Promise((r) => setTimeout(r, 1_000))
  }
  try {
    if (!(await reachable(url))) {
      for (const r of open) r.reasons.push('unjudged: no judge reachable')
      return 'unreachable'
    }
    const input = path.join(runDir, 'to-judge.json')
    fs.writeFileSync(
      input,
      JSON.stringify(
        open.map(({ suite, id, q, answer, judge: rubric }) => ({ suite, id, q, answer, rubric })),
        null,
        1
      )
    )
    const res = spawnSync(
      'python3',
      [
        path.join(DESKTOP, 'scripts', 'action-data', 'e2e', 'judge.py'),
        '--eval',
        input,
        '--url',
        url
      ],
      { encoding: 'utf8' }
    )
    if (res.status !== 0) throw new Error(`judge failed: ${res.stderr}`)
    const verdicts = readJson<{ id: string; verdict: string; reason: string }[]>(
      input.replace('.json', '.judged.json')
    )
    for (const v of verdicts) {
      const r = open.find((o) => o.id === v.id)!
      r.pass = v.verdict === 'pass'
      if (!r.pass) r.reasons.push(`judge: ${v.reason}`)
      // The judge sees no citations: a Brain answer that cites no gold source still fails.
      else if (r.suite === 'brain' && r.cited === false) {
        r.pass = false
        r.reasons.push('no citation of a gold source')
      }
    }
    return name
  } finally {
    server?.kill()
  }
}

// --- Run ---------------------------------------------------------------------------------------

const summarise = (rows: Row[]): Record<string, unknown> => {
  const judged = rows.filter((r) => r.pass !== null)
  const pct = (n: number, d: number): number | null => (d ? Math.round((1000 * n) / d) / 10 : null)
  const mean = (xs: number[]): number | null =>
    xs.length ? Math.round((10 * xs.reduce((a, b) => a + b, 0)) / xs.length) / 10 : null
  return {
    cases: rows.length,
    passRate: pct(judged.filter((r) => r.pass).length, judged.length),
    unjudged: rows.length - judged.length,
    errors: rows.filter((r) => r.error).length,
    meanTurns: mean(rows.map((r) => r.turns)),
    meanPromptTokens: mean(rows.map((r) => r.promptTokens)),
    meanSeconds: mean(rows.map((r) => r.ms / 1000)),
    ...(rows.some((r) => r.recallAt10 !== undefined)
      ? {
          recallAt10: pct(rows.filter((r) => r.recallAt10).length, rows.length),
          // Right answer, whether or not it cited a gold source.
          answerRate: pct(
            rows.filter((r) => r.reasons.every((reason) => reason.startsWith('no citation')))
              .length,
            rows.length
          ),
          citedRate: pct(rows.filter((r) => r.cited).length, rows.length)
        }
      : {})
  }
}

async function main(): Promise<void> {
  log('profile', profileDir, 'models', MODELS_DIR, 'run', runDir)
  // A memories.db without a .dbkey opens as plaintext, so the seeder can write to it.
  fs.writeFileSync(path.join(profileDir, 'memories.db'), '')
  let { app, page } = await open()
  await call(page, 'meetingList') // creates the meetings table
  const recommendation = await call<{ id: string; name: string }>(page, 'setupRecommendation')
  await app.close()

  const keys = seedProfile(
    path.join(profileDir, 'memories.db'),
    readJson<Profile>(path.join(SHARED_EVAL, 'profile.json'))
  )
  log('seeded', Object.keys(keys).length, 'items')

  // --model-file runs a GGUF already on disk (linked, never copied or moved) as the active model.
  const modelFile = flag('model-file')
  if (modelFile) {
    const link = path.join(MODELS_DIR, path.basename(modelFile))
    if (!fs.existsSync(link)) fs.symlinkSync(path.resolve(modelFile), link)
    fs.writeFileSync(
      path.join(MODELS_DIR, 'active-model.json'),
      JSON.stringify({
        id: path.basename(modelFile, '.gguf'),
        primary: path.basename(modelFile),
        mmproj: null
      })
    )
  }
  ;({ app, page } = await open())
  for (const name of SIDE_EFFECT_TOOLS) await call(page, 'setToolEnabled', name, false)
  const modelId = modelFile
    ? path.basename(modelFile, '.gguf')
    : (flag('model') ?? recommendation.id)
  log(
    'model',
    modelId,
    modelFile ? '(--model-file)' : flag('model') ? '(--model)' : '(app recommendation)'
  )
  if (!modelFile) {
    await call(page, 'downloadModel', modelId)
    await call(page, 'activateModel', modelId)
  }
  const warm = await ask(page, 'Say OK.', { conversationId: crypto.randomUUID(), thinking: false })
  if (warm.error) throw new Error(`model did not answer: ${warm.error}`)
  const appVersion = await app.evaluate(({ app: electronApp }) => electronApp.getVersion())

  // Wait for the records engine to embed the seeded rows (keyword search works meanwhile).
  let status = { vectors: 0, pending: -1 }
  for (let i = 0; i < 900; i++) {
    status = await call<{ vectors: number; pending: number }>(page, 'searchStatus')
    if (status.pending === 0 && status.vectors > 0) break
    await new Promise((r) => setTimeout(r, 2_000))
  }
  log('record vectors', status)

  const rows: Row[] = []
  if (suites.includes('brain')) rows.push(...(await brain(page, keys)))
  if (suites.includes('tools')) rows.push(...(await tools(page)))
  if (suites.includes('documents')) rows.push(...(await documents(page)))
  if (suites.includes('chat')) rows.push(...(await chat(page)))
  await app.close()

  const resultsFile = path.join(runDir, 'results.json')
  // Saved before judging, so a failed judge keeps every answer and metric.
  fs.writeFileSync(resultsFile, JSON.stringify({ keys, rows }, null, 1))
  const judgeName = await judge(rows)
  fs.writeFileSync(resultsFile, JSON.stringify({ keys, rows }, null, 1))

  const card: Record<string, unknown> = {}
  for (const suite of CASE_SUITES) {
    const of = rows.filter((r) => r.suite === suite)
    if (of.length) card[suite] = summarise(of)
  }
  if (suites.includes('computer-use')) {
    // The existing replay benchmark, unchanged; it needs recorded fixtures.
    const fixtures = (flag('computer-use-fixtures') ?? '').split(',').filter(Boolean)
    if (fixtures.length) {
      const res = spawnSync(
        'node',
        [path.join(DESKTOP, 'scripts', 'computer-use-benchmark.mjs'), ...fixtures],
        { encoding: 'utf8' }
      )
      card['computer-use'] =
        res.status === 0 ? JSON.parse(res.stdout) : { error: res.stderr.trim() }
    } else {
      card['computer-use'] = { skipped: 'no recorded fixtures given (--computer-use-fixtures)' }
    }
  }
  const commit = (dir: string): string =>
    spawnSync('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8'
    }).stdout.trim()
  const scorecard = {
    platform: 'desktop-mac',
    date: new Date().toISOString(),
    model: modelId,
    modelSource: modelFile ? `file ${modelFile}` : flag('model') ? 'flag' : 'app recommendation',
    adapter,
    app: {
      version: appVersion,
      desktop: commit(DESKTOP),
      shared: commit(path.dirname(SHARED_EVAL))
    },
    machine: { ramGb: Math.round(os.totalmem() / 2 ** 30), cpu: os.cpus()[0]?.model },
    judge: judgeName,
    recordVectors: status,
    disabledTools: SIDE_EFFECT_TOOLS,
    suites: card,
    run: runDir
  }
  const outDir = path.join(SHARED_EVAL, 'scorecards')
  fs.mkdirSync(outDir, { recursive: true })
  const slug = modelId.replace(/[^A-Za-z0-9.-]+/g, '_')
  const out = path.join(
    outDir,
    `${stamp.slice(0, 10)}-desktop-${slug}-${adapter}-${stamp.slice(11)}.json`
  )
  fs.writeFileSync(out, `${JSON.stringify(scorecard, null, 2)}\n`)
  log('scorecard', out)
  console.log(JSON.stringify(card, null, 2))
  if (!argv.includes('--keep-profile')) fs.rmSync(profileDir, { recursive: true, force: true })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
