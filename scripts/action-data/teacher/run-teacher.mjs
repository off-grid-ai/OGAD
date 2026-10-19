// Run a teacher model on browser tasks through the OpenCode CLI, with oc-proxy.mjs as its only
// tool server. Each task gets its own folder (opencode.json + rows); rows land in --out/<task id>/.
//
//   node run-teacher.mjs --tasks tasks.json --out <dir> [--model opencode/deepseek-v4.1-flash-free]
//        [--parallel 2] [--only id,id] [--minutes 10]
// tasks.json: [{ "id", "goal", "url", "writes": false }]

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = Object.fromEntries(process.argv.slice(2).reduce((p, v, i, all) => { if (v.startsWith('--')) p.push([v.slice(2), all[i + 1]]); return p }, []))
const here = dirname(fileURLToPath(import.meta.url))
const proxy = join(here, 'oc-proxy.mjs')
const out = resolve(args.out)
const model = args.model ?? 'opencode/deepseek-v4.1-flash-free'
const parallel = Number(args.parallel ?? 2)
const minutes = Number(args.minutes ?? 10)
const only = args.only ? new Set(args.only.split(',')) : null
const tasks = JSON.parse(readFileSync(args.tasks, 'utf8')).filter((t) => !only || only.has(t.id))

const PROMPT = (t) => `You control a web browser through the ogad tools. Goal: ${t.goal}
The browser is already open at ${t.url}.
How to work:
1. Call browser_snapshot to see the page. Then call ogad_plan with short steps for what you can see.
2. Before each action, call ogad_step with the step number you are doing.
3. Act with browser_click / browser_type / browser_select_option / browser_press_key / browser_navigate_back, one action at a time, using refs from the latest snapshot.
4. If the page is not what the plan expected, call ogad_plan again with the remaining steps.
5. When the goal is met, call ogad_done with the specific answer copied from the page (exact names, prices, numbers). If it cannot be done, call ogad_fail.
Do not use any other tools: bash, files and web fetch are blocked here. Do not ask questions; work until ogad_done or ogad_fail.`

function runOne(t, slot) {
  const dir = join(out, t.id)
  if (existsSync(join(dir, `${t.id}.done`))) return Promise.resolve({ id: t.id, skipped: true })
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'task.json'), JSON.stringify(t))
  writeFileSync(join(dir, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    // A local llama-server (OGAD's engine) as an OpenAI-compatible provider: --model ogadlocal/<name>
    ...(model.startsWith('ogadlocal/') ? { provider: { ogadlocal: { npm: '@ai-sdk/openai-compatible', name: 'OGAD local', options: { baseURL: process.env.OGAD_LOCAL_URL ?? 'http://127.0.0.1:8095/v1' }, models: { [model.split('/')[1]]: { name: model.split('/')[1], tool_call: true } } } } } : {}),
    mcp: { ogad: { type: 'local', command: ['node', proxy, '--task', join(dir, 'task.json'), '--out', dir], enabled: true, environment: { CHROME_PATH: process.env.CHROME_PATH ?? '', ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}) } } }, // headed Chrome needs the virtual display on a server
    // OpenCode's own tools stay listed (normal OpenCode use), but anything that touches the machine or the web outside the browser is denied.
    permission: { bash: 'deny', edit: 'deny', write: 'deny', patch: 'deny', webfetch: 'deny', websearch: 'deny', task: 'deny', skill: 'deny', external_directory: 'deny' }
  }, null, 1))
  return new Promise((done) => {
    const started = Date.now()
    const child = spawn('opencode', ['run', '-m', model, '--auto', '--format', 'json', '--dir', dir, PROMPT(t)], { cwd: dir, env: { ...process.env, PWD: dir, ...slotEnv(slot) }, stdio: ['ignore', 'pipe', 'pipe'] })
    const logs = []
    // A spawn can fail when the pod hits its process limit; record it and move on instead of crashing the batch.
    child.on('error', (e) => { clearTimeout(timer); writeFileSync(join(dir, 'opencode.log'), String(e)); done({ id: t.id, end: 'spawn-error', code: null, seconds: 0 }) })
    child.stdout.on('data', (d) => logs.push(d))
    child.stderr.on('data', (d) => logs.push(d))
    const timer = setTimeout(() => child.kill('SIGTERM'), minutes * 60_000)
    child.on('exit', (code) => {
      clearTimeout(timer)
      // A timed-out run can leave its browser wrapper behind; close it with the task.
      spawn('pkill', ['-f', `oc-proxy.mjs --task ${join(dir, 'task.json')}`])
      writeFileSync(join(dir, 'opencode.log'), Buffer.concat(logs))
      const end = existsSync(join(dir, `${t.id}.done`)) ? readFileSync(join(dir, `${t.id}.done`), 'utf8') : 'no-finish'
      done({ id: t.id, end, code, seconds: Math.round((Date.now() - started) / 1000) })
    })
  })
}

// Each worker gets its own OpenCode data folder: parallel runs on one SQLite file lock each other.
function slotEnv(slot) {
  const base = join(out, `.oc-slot${slot}`)
  for (const d of ['data', 'state', 'cache']) mkdirSync(join(base, d), { recursive: true })
  return { XDG_DATA_HOME: join(base, 'data'), XDG_STATE_HOME: join(base, 'state'), XDG_CACHE_HOME: join(base, 'cache') }
}

const queue = [...tasks]
const results = []
await Promise.all(Array.from({ length: parallel }, async (_, slot) => {
  while (queue.length) {
    const r = await runOne(queue.shift(), slot)
    results.push(r)
    console.log(JSON.stringify(r))
  }
}))
writeFileSync(join(out, `summary-${Date.now()}.json`), JSON.stringify(results, null, 1))
