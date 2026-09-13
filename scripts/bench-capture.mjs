#!/usr/bin/env node
// Benchmark the VISION understanding path on REAL stored frames — single frame vs N-frame
// batches — so the "how many frames per vision call" decision is made with numbers.
// OCR is a dead path (production grounds on the Accessibility tree, fetched live and ~free),
// so this bench does NOT run OCR; it measures the image legs only.
//
// Legs (per downscaled frame, JPEG via macOS `sips -Z` — the pixel cap is the token lever):
//   vision-single — ONE downscaled frame image → model
//   vision-batch  — N consecutive downscaled frames → model  (--batch N, comma list for several)
//
// Usage:
//   node scripts/bench-capture.mjs --n 12                          # single-frame only
//   node scripts/bench-capture.mjs --n 12 --batch 3 --show         # + 3-frame batch, print outputs
//   node scripts/bench-capture.mjs --n 40 --batch 5,7,9 --batch-only --show   # sweep, no single loop
//   options: --dir <dir> --port 8439 --max-dim 1024 --max-tokens 512 --single-ms 1780
//
// Note: the AX text would ride along in production at ~free cost; omitted here so the numbers
// isolate the IMAGE cost — the only lever that scales with frame count.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const argv = process.argv.slice(2)
const arg = (flag, def) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const has = (flag) => argv.includes(flag)

const CAPTURES = arg(
  '--dir',
  path.join(os.homedir(), 'Library/Application Support/Off Grid AI Desktop/captures')
)
const N = Number(arg('--n', '12'))
const PORT = Number(arg('--port', '8439'))
const MAX_TOKENS = Number(arg('--max-tokens', '512'))
const MAX_DIM = Number(arg('--max-dim', '1024'))
const BATCHES = arg('--batch', '0')
  .split(',')
  .map((x) => Number(x.trim()))
  .filter((n) => n > 1)
const BATCH_ONLY = has('--batch-only') // skip the single-frame loop (reuse a known baseline)
const SINGLE_MS = Number(arg('--single-ms', '1780')) // baseline used when --batch-only
const SHOW = has('--show')
const JUDGE = has('--judge') // grade each summary against the ACTUAL current frame (quality vs N)
const SPREAD = has('--spread')
const ENDPOINT = `http://127.0.0.1:${PORT}/v1/chat/completions`
const TMP = path.join(os.tmpdir(), 'ogad-bench')

const INSTRUCTION =
  'You log what the user is doing on their computer. From the screen below, reply with a one-sentence factual summary and the people/projects it is about. Be concrete; do not infer.'
const BATCH_INSTRUCTION = (n) =>
  `You log what the user is doing on their computer. The ${n} images below are consecutive screen frames in time order (oldest first). Use the SEQUENCE to understand what is happening on the CURRENT (last) frame; earlier frames are context only. Reply with a one-sentence factual summary of the current frame and the people/projects it is about. Be concrete; do not infer.`

const nowMs = () => Number(process.hrtime.bigint() / 1000n) / 1000
const kb = (bytes) => `${(bytes / 1024).toFixed(0)}KB`
const clip = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 300)

function pickFrames() {
  const all = readdirSync(CAPTURES)
    .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
    .filter((f) => !f.includes('-crop'))
    .map((f) => path.join(CAPTURES, f))
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  if (all.length === 0) throw new Error(`no frames in ${CAPTURES}`)
  if (SPREAD && all.length > N) {
    const step = all.length / N
    return Array.from({ length: N }, (_, i) => all[Math.floor(i * step)].p)
  }
  return all.slice(0, N).map((x) => x.p)
}

let tmpMade = false
function downscale(imagePath, maxDim) {
  if (!tmpMade) {
    execFileSync('mkdir', ['-p', TMP])
    tmpMade = true
  }
  const out = path.join(TMP, `${path.basename(imagePath, path.extname(imagePath))}.jpg`)
  const t = nowMs()
  execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', String(maxDim), imagePath, '--out', out], {
    stdio: 'pipe'
  })
  return { path: out, ms: nowMs() - t, bytes: statSync(out).size }
}

async function callModel(content, label) {
  const body = JSON.stringify({
    messages: [{ role: 'user', content }],
    max_tokens: MAX_TOKENS,
    temperature: 0.2,
    chat_template_kwargs: { enable_thinking: false }
  })
  const t = nowMs()
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  })
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${await res.text().catch(() => '')}`)
  const data = await res.json()
  return {
    ms: nowMs() - t,
    outTokens: data.usage?.completion_tokens ?? 0,
    promptTokens: data.usage?.prompt_tokens ?? 0,
    text: data.choices?.[0]?.message?.content ?? ''
  }
}

function imagePart(imagePath) {
  const b64 = readFileSync(imagePath).toString('base64')
  const mime = imagePath.toLowerCase().endsWith('.jpg') ? 'image/jpeg' : 'image/png'
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } }
}
const visionSingle = (downPath) =>
  callModel([{ type: 'text', text: INSTRUCTION }, imagePart(downPath)], 'vision-single')
const visionBatch = (downPaths) =>
  callModel(
    [{ type: 'text', text: BATCH_INSTRUCTION(downPaths.length) }, ...downPaths.map(imagePart)],
    `vision-batch-${downPaths.length}`
  )

// LLM-as-judge: show ONLY the current (last) frame + the produced summary, and grade how well the
// summary describes THAT frame. This is the quality-vs-batch-size signal — a bigger window is only
// worth it if the current-frame summary does not degrade (conflate/vague/hallucinate) as N grows.
const JUDGE_INSTRUCTION =
  'Below is a screenshot and a one-sentence summary that was written to describe it. Grade the summary against ONLY what is visible in this image. Score each 1-5 (integers):\n' +
  'ACCURACY: does it match what is actually on screen (5=exact, 1=wrong screen)\n' +
  'SPECIFICITY: concrete names/apps/projects vs vague generalities (5=names the real thing, 1=generic)\n' +
  'GROUNDING: states only what is visible, invents nothing (5=fully grounded, 1=hallucinated detail)\n' +
  'Reply with EXACTLY one line: ACCURACY=<n> SPECIFICITY=<n> GROUNDING=<n>'
async function judgeSummary(currentFramePath, summary) {
  const r = await callModel(
    [
      { type: 'text', text: `${JUDGE_INSTRUCTION}\n\nSUMMARY: "${clip(summary)}"` },
      imagePart(currentFramePath)
    ],
    'judge'
  )
  const g = (k) => {
    const m = new RegExp(`${k}\\s*[=:]\\s*([1-5])`, 'i').exec(r.text)
    return m ? Number(m[1]) : null
  }
  const acc = g('ACCURACY')
  const spec = g('SPECIFICITY')
  const grd = g('GROUNDING')
  return { acc, spec, grd, parsed: acc != null && spec != null && grd != null }
}
const scoreOf = (j) => (j.parsed ? (j.acc + j.spec + j.grd) / 3 : null)

function stats(xs) {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const q = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, p50: q(50), p95: q(95) }
}
const f = (v) => (v == null ? '   —' : `${v.toFixed(0)}`.padStart(6))
const row = (name, st) =>
  st
    ? `  ${name.padEnd(22)} mean ${f(st.mean)}  p50 ${f(st.p50)}  p95 ${f(st.p95)}   (n=${st.n})`
    : `  ${name.padEnd(22)} (no data)`
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

async function main() {
  console.log(`\nVision benchmark — up to ${N} frames · max-dim ${MAX_DIM}px · engine ${ENDPOINT}`)
  console.log(
    `legs: ${BATCH_ONLY ? '' : 'vision-single (1 image), '}${BATCHES.length ? `vision-batch (${BATCHES.join('/')} images)` : ''} · NO OCR (dead path)\n`
  )
  const frames = pickFrames()
  const chrono = [...frames].reverse() // oldest→newest, for temporal batch windows

  process.stdout.write('warming up… ')
  {
    const d = downscale(frames[0], MAX_DIM)
    await visionSingle(d.path).catch(() => {})
    rmSync(d.path, { force: true })
  }
  console.log('done\n')

  const S = { down: [], single: [] }
  const promptSingle = []
  const singleScores = [] // judge scores for single-frame summaries (quality baseline)

  if (!BATCH_ONLY) {
    for (let i = 0; i < frames.length; i++) {
      const fr = frames[i]
      const d = downscale(fr, MAX_DIM)
      S.down.push(d.ms)
      let line = `downscale ${d.ms.toFixed(0)} (${kb(d.bytes)})`
      try {
        const v = await visionSingle(d.path)
        S.single.push(v.ms)
        promptSingle.push(v.promptTokens)
        line += ` · vision ${v.ms.toFixed(0)}ms · ${v.promptTokens}→${v.outTokens}tok`
        if (JUDGE) {
          const j = await judgeSummary(d.path, v.text)
          const sc = scoreOf(j)
          if (sc != null) singleScores.push(sc)
          line += ` · Q ${sc == null ? '?' : sc.toFixed(1)} (a${j.acc ?? '?'} s${j.spec ?? '?'} g${j.grd ?? '?'})`
        }
        if (SHOW) console.log(`\n  ▸ ${path.basename(fr)}\n    single: ${clip(v.text)}\n`)
      } catch (e) {
        line += ` · vision FAILED (${String(e.message).slice(0, 60)})`
      } finally {
        rmSync(d.path, { force: true })
      }
      console.log(`  [${String(i + 1).padStart(2)}/${frames.length}] ${line}`)
    }
  }

  const legStats = [] // { B, ms:[], prompt:[], scores:[] }
  for (const B of BATCHES) {
    const msArr = []
    const promptArr = []
    const scoreArr = []
    console.log(`\n── batch leg: ${B} frames per call ──`)
    for (let i = 0; i + B <= chrono.length; i += B) {
      const window = chrono.slice(i, i + B)
      const downs = window.map((fr) => downscale(fr, MAX_DIM))
      const totalKb = downs.reduce((a, d) => a + d.bytes, 0)
      try {
        const v = await visionBatch(downs.map((d) => d.path))
        msArr.push(v.ms)
        promptArr.push(v.promptTokens)
        // Judge against the CURRENT (last) frame only — the summary is meant to describe it.
        let qNote = ''
        if (JUDGE) {
          const j = await judgeSummary(downs[downs.length - 1].path, v.text)
          const sc = scoreOf(j)
          if (sc != null) scoreArr.push(sc)
          qNote = ` · Q ${sc == null ? '?' : sc.toFixed(1)} (a${j.acc ?? '?'} s${j.spec ?? '?'} g${j.grd ?? '?'})`
        }
        if (SHOW) console.log(`\n  ▸ [${window.length}f]${qNote}\n    batch:  ${clip(v.text)}\n`)
        else
          console.log(
            `  win[${i / B + 1}] ${B}f · ${kb(totalKb)} · ${v.ms.toFixed(0)}ms · ${v.promptTokens}→${v.outTokens}tok${qNote}`
          )
      } catch (e) {
        console.log(`  batch(${B}) FAILED (${String(e.message).slice(0, 90)})`)
      } finally {
        downs.forEach((d) => rmSync(d.path, { force: true }))
      }
    }
    legStats.push({ B, ms: msArr, prompt: promptArr, scores: scoreArr })
  }

  console.log('\n── per-stage (ms) ──')
  if (!BATCH_ONLY) {
    console.log(row('downscale (sips)', stats(S.down)))
    console.log(row('vision-single (1f)', stats(S.single)))
  }
  for (const { B, ms } of legStats) console.log(row(`vision-batch (${B}f)`, stats(ms)))

  console.log('\n── scaling (find the knee) ──')
  const base = BATCH_ONLY ? SINGLE_MS : mean(S.single) || SINGLE_MS
  const baseQ = singleScores.length ? mean(singleScores) : null
  console.log(
    `  single-frame baseline: ${base.toFixed(0)} ms/call` +
      (baseQ != null ? ` · Q ${baseQ.toFixed(2)}/5 (n=${singleScores.length})` : '')
  )
  for (const { B, ms, prompt, scores } of legStats) {
    if (!ms.length) {
      console.log(`  ${B}f: no successful calls (model likely rejected ${B} images)`)
      continue
    }
    const perCall = mean(ms)
    const q = scores.length ? mean(scores) : null
    console.log(
      `  ${B}f: ${perCall.toFixed(0)} ms/call · ${mean(prompt).toFixed(0)} prompt tok · ` +
        `${(perCall / base).toFixed(2)}× a single call · ` +
        `per-frame ${(perCall / B).toFixed(0)} ms · ${(base / (perCall / B)).toFixed(2)}× throughput vs 1-by-1` +
        (q != null
          ? ` · Q ${q.toFixed(2)}/5${baseQ != null ? ` (${(q - baseQ >= 0 ? '+' : '') + (q - baseQ).toFixed(2)} vs single)` : ''} (n=${scores.length})`
          : '')
    )
  }
  if (tmpMade) rmSync(TMP, { recursive: true, force: true })
  console.log('')
}

main().catch((e) => {
  console.error('\nbench failed:', e.message)
  process.exit(1)
})
