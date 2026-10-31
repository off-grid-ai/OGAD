#!/usr/bin/env node
// Moves resources/engine-pins.json to the newest upstream engines: llama.cpp, the Prism fork,
// stable-diffusion.cpp, whisper.cpp, sherpa-onnx (Parakeet) and the NVIDIA CUDA libraries the ONNX
// pack carries.
// Every asset hash comes from the SHA-256 GitHub (or PyPI) publishes for it. An engine whose
// newest release lacks any asset we ship is left on its current pin and reported, so a changed
// upstream layout never produces a half-updated pin.
//
//   node scripts/update-engine-pins.mjs [--summary <file.md>] [--dry-run]
//     [--engines llama,prism,sd,whisper,sherpa,nvidia] [--llama-min-builds <n>]
//
// llama.cpp tags several builds a day; --llama-min-builds moves it only once upstream is at least
// that many builds ahead, so a nightly run does not rebuild every engine every night.
//
// Prints one line of JSON: { "changed": ["llama", ...], "skipped": [{ engine, reason }] }.
import fs from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    summary: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    engines: { type: 'string', default: 'llama,prism,sd,whisper,sherpa,nvidia' },
    'llama-min-builds': { type: 'string', default: '1' }
  }
})
const engines = new Set(
  values.engines
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)
)
const llamaMinBuilds = Number(values['llama-min-builds'])
const PINS_FILE = new URL('../resources/engine-pins.json', import.meta.url)
const pins = JSON.parse(fs.readFileSync(PINS_FILE, 'utf8'))

const headers = {
  Accept: 'application/vnd.github+json',
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {})
}
async function json(url, init) {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return response.json()
}
const github = (path) => json(`https://api.github.com/${path}`, { headers })

/** Newest published release whose tag matches. llama.cpp marks every bNNNN build a prerelease,
 *  so the strict tag pattern, not the prerelease flag, decides what counts. */
async function latestRelease(repo, tagPattern, { prerelease = false } = {}) {
  const releases = await github(`repos/${repo}/releases?per_page=30`)
  const release = releases.find(
    (r) => !r.draft && (prerelease || !r.prerelease) && tagPattern.test(r.tag_name)
  )
  if (!release) throw new Error(`${repo}: no release matching ${tagPattern}`)
  return release
}

/** { key: sha256 } for the named assets, or the names that are missing. */
function digests(release, names) {
  const sha256 = {}
  const missing = []
  for (const [key, name] of Object.entries(names)) {
    const asset = release.assets.find((a) => a.name === name)
    const digest = asset?.digest?.replace(/^sha256:/, '')
    if (digest && /^[0-9a-f]{64}$/.test(digest)) sha256[key] = digest
    else missing.push(name)
  }
  return { sha256, missing }
}

async function tagCommit(repo, tag) {
  const ref = await github(`repos/${repo}/git/ref/tags/${tag}`)
  if (ref.object.type === 'commit') return ref.object.sha
  return (await github(`repos/${repo}/git/tags/${ref.object.sha}`)).object.sha
}

const changed = []
const skipped = []
const lines = []

function apply(engine, next, from, to) {
  if (from === to) return
  const missing = next.missing ?? []
  if (missing.length) {
    skipped.push({ engine, reason: `${to} lacks ${missing.join(', ')}` })
    return
  }
  delete next.missing
  Object.assign(pins[engine], next)
  changed.push(engine)
  lines.push(`| ${engine} | \`${from}\` | \`${to}\` |`)
}

async function updateLlama() {
  const release = await latestRelease(pins.llama.repo, /^b\d+$/, { prerelease: true })
  const ref = release.tag_name
  const ahead = Number(ref.slice(1)) - Number(pins.llama.ref.slice(1))
  if (ahead > 0 && ahead < llamaMinBuilds) {
    skipped.push({
      engine: 'llama',
      reason: `${ref} is ${ahead} builds ahead; waiting for ${llamaMinBuilds}`
    })
    return
  }
  const { sha256, missing } = digests(release, {
    'linux-cuda': `llama-${ref}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
    'linux-cudart': `cudart-llama-${ref}-bin-ubuntu-cuda-12.8-x64.tar.gz`,
    'linux-vulkan': `llama-${ref}-bin-ubuntu-vulkan-x64.tar.gz`,
    'linux-cpu': `llama-${ref}-bin-ubuntu-x64.tar.gz`,
    'win-cuda': `llama-${ref}-bin-win-cuda-12.4-x64.zip`,
    'win-cudart': 'cudart-llama-bin-win-cuda-12.4-x64.zip',
    'win-vulkan': `llama-${ref}-bin-win-vulkan-x64.zip`,
    'win-cpu': `llama-${ref}-bin-win-cpu-x64.zip`
  })
  apply('llama', { ref, sha256, missing }, pins.llama.ref, ref)
}

async function updatePrism() {
  const release = await latestRelease(pins.prism.repo, /^prism-b\d+-[0-9a-f]+$/, {
    prerelease: true
  })
  const ref = release.tag_name
  const { sha256, missing } = digests(release, {
    'linux-cuda': `llama-${ref}-bin-linux-cuda-12.8-x64.tar.gz`,
    'linux-vulkan': `llama-${ref}-bin-ubuntu-vulkan-x64.tar.gz`,
    'linux-cpu': `llama-${ref}-bin-ubuntu-x64.tar.gz`,
    'win-cuda': `llama-${ref}-bin-win-cuda-12.4-x64.zip`,
    'win-vulkan': `llama-${ref}-bin-win-vulkan-x64.zip`,
    'win-cpu': `llama-${ref}-bin-win-cpu-x64.zip`
  })
  apply('prism', { ref, sha256, missing }, pins.prism.ref, ref)
}

async function updateSd() {
  const release = await latestRelease(pins.sd.repo, /^master-\d+-[0-9a-f]+$/)
  const ref = release.tag_name
  const short = ref.split('-').at(-1)
  const { sha256, missing } = digests(release, {
    'linux-vulkan': `sd-master-${short}-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip`,
    'win-cuda': `sd-master-${short}-bin-win-cuda12-x64.zip`,
    'win-vulkan': `sd-master-${short}-bin-win-vulkan-x64.zip`,
    'win-cpu': `sd-master-${short}-bin-win-cpu-x64.zip`
  })
  const commit = ref === pins.sd.ref ? pins.sd.commit : await tagCommit(pins.sd.repo, ref)
  apply('sd', { ref, commit, sha256, missing }, pins.sd.ref, ref)
}

async function updateWhisper() {
  const release = await latestRelease(pins.whisper.repo, /^v\d+\.\d+\.\d+$/)
  const ref = release.tag_name
  if (ref === pins.whisper.ref) return
  // The semantic release has no Windows binaries; the bNNNN release of the same commit does.
  const commit = await tagCommit(pins.whisper.repo, ref)
  const releases = await github(`repos/${pins.whisper.repo}/releases?per_page=30`)
  let winRelease
  for (const candidate of releases.filter((r) => /^b\d+$/.test(r.tag_name))) {
    if ((await tagCommit(pins.whisper.repo, candidate.tag_name)) === commit) {
      winRelease = candidate
      break
    }
  }
  if (!winRelease) {
    skipped.push({ engine: 'whisper', reason: `no bNNNN release with Windows binaries for ${ref}` })
    return
  }
  const { sha256, missing } = digests(winRelease, {
    'win-cuda': 'whisper-bin-win-cuda-12.4.0-x64.zip',
    'win-cpu': 'whisper-bin-x64.zip'
  })
  apply(
    'whisper',
    { ref, commit, winRef: winRelease.tag_name, sha256, missing },
    pins.whisper.ref,
    ref
  )
}

/** sherpa-onnx ships prebuilt shared builds for every platform; release jobs fetch them as-is
 *  (scripts/fetch-sherpa.mjs), so a new pin needs no archive rebuild. */
async function updateSherpa() {
  const release = await latestRelease(pins.sherpa.repo, /^v\d+\.\d+\.\d+$/)
  const ref = release.tag_name
  const { sha256, missing } = digests(release, {
    'mac-universal': `sherpa-onnx-${ref}-osx-universal2-shared.tar.bz2`,
    'linux-x64': `sherpa-onnx-${ref}-linux-x64-shared.tar.bz2`,
    'win-x64': `sherpa-onnx-${ref}-win-x64-shared-MT-Release.tar.bz2`
  })
  apply('sherpa', { ref, sha256, missing }, pins.sherpa.ref, ref)
}

/** Newest release in the same major version that has a wheel for the platform. */
async function pypiLatest(name, current, wheelPattern) {
  const data = await json(`https://pypi.org/pypi/${name}/json`)
  const major = current.split('.')[0]
  const versions = Object.keys(data.releases)
    .filter((v) => /^\d+(\.\d+)*$/.test(v) && v.split('.')[0] === major)
    .sort((a, b) => {
      const pa = a.split('.').map(Number)
      const pb = b.split('.').map(Number)
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
      }
      return 0
    })
  for (const version of versions.reverse()) {
    const wheel = data.releases[version].find((f) => wheelPattern.test(f.filename) && !f.yanked)
    if (wheel) return { version, sha256: wheel.digests.sha256 }
  }
  return null
}

async function updateNvidia() {
  const before = JSON.stringify(pins.nvidia)
  for (const [name, version] of Object.entries(pins.nvidia.linux)) {
    const latest = await pypiLatest(name, version, /manylinux.*x86_64\.whl$/)
    if (latest && latest.version !== version) {
      lines.push(`| ${name} (Linux) | \`${version}\` | \`${latest.version}\` |`)
      pins.nvidia.linux[name] = latest.version
    }
  }
  for (const [name, pin] of Object.entries(pins.nvidia.win)) {
    const latest = await pypiLatest(name, pin.version, /-py3-none-win_amd64\.whl$/)
    if (latest && latest.version !== pin.version) {
      lines.push(`| ${name} (Windows) | \`${pin.version}\` | \`${latest.version}\` |`)
      pins.nvidia.win[name] = latest
    }
  }
  if (JSON.stringify(pins.nvidia) !== before) changed.push('nvidia')
}

const updates = {
  llama: updateLlama,
  prism: updatePrism,
  sd: updateSd,
  whisper: updateWhisper,
  sherpa: updateSherpa,
  nvidia: updateNvidia
}
for (const [engine, update] of Object.entries(updates)) {
  if (!engines.has(engine)) continue
  try {
    await update()
  } catch (error) {
    skipped.push({ engine, reason: String(error.message ?? error) })
  }
}

if (changed.length && !values['dry-run']) {
  fs.writeFileSync(PINS_FILE, `${JSON.stringify(pins, null, 2)}\n`)
}
if (values.summary) {
  const body = [
    changed.length
      ? '| Engine | From | To |\n|---|---|---|\n' + lines.join('\n')
      : 'Every engine is on its newest release.',
    ...(skipped.length
      ? ['', '**Left on the current pin:**', ...skipped.map((s) => `- ${s.engine}: ${s.reason}`)]
      : [])
  ].join('\n')
  fs.writeFileSync(values.summary, `${body}\n`)
}
console.log(JSON.stringify({ changed, skipped }))
