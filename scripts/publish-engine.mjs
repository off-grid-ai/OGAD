#!/usr/bin/env node
// Publish a staged engine folder to the runtime store and sign the platform's engine index.
//
//   node scripts/publish-engine.mjs --platform darwin|linux|win32 --dir build/engines/linux/llama \
//     [--index v2|legacy] [--min-app 0.0.56] [--dry-run]
//   node scripts/publish-engine.mjs --platform linux|win32 --pack resources/performance-packs.json
//
// The folder comes from scripts/stage-engines.mjs or scripts/stage-llama-engine.mjs and holds
// engine.json ({id, version, minApp?, smokeTest, requires?}) beside the files the engine runs. `--index v2`
// (the default) writes index-v2.json, which current apps read; `--index legacy` writes index.json,
// which apps before every engine was updatable read and which should only ever list llama-cuda. Each file is uploaded once under its SHA-256 and never changes;
// the index for the platform is rewritten with this release in place of the engine's previous one,
// then signed with ENGINE_SIGNING_PRIVATE_KEY (base64 PKCS#8 Ed25519). The app refuses any index whose
// signature does not match the public key in src/shared/engine-updates.ts.
//
// `--pack` names the platform's CUDA pack from the manifest in index-v2.json instead, so apps move to
// a new pack without an app release. The pack itself is already on the store (update-engines.yml).
//
// Environment: R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, ENGINE_SIGNING_PRIVATE_KEY.
import { createHash, createHmac, createPrivateKey, sign } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    platform: { type: 'string' },
    dir: { type: 'string' },
    pack: { type: 'string' },
    'min-app': { type: 'string' },
    index: { type: 'string', default: 'v2' },
    'dry-run': { type: 'boolean', default: false }
  }
})
const platform = values.platform
const packMode = Boolean(values.pack)
if (
  !['darwin', 'linux', 'win32'].includes(platform) ||
  (packMode ? platform === 'darwin' || values.dir : !values.dir) ||
  !['v2', 'legacy'].includes(values.index)
) {
  console.error(
    'Usage: publish-engine.mjs --platform darwin|linux|win32 --dir <staged folder> [--index v2|legacy] [--min-app <version>] [--dry-run]\n' +
      '       publish-engine.mjs --platform linux|win32 --pack <performance-packs.json>'
  )
  process.exit(1)
}
const dryRun = values['dry-run']
const env = (name) => {
  const value = process.env[name]
  if (!value && !dryRun) throw new Error(`${name} is not set`)
  return value ?? ''
}

// ---- What the engine is made of ----------------------------------------------------------------
async function sha256Of(file) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

const dir = packMode ? null : path.resolve(values.dir)
const engine = packMode ? null : JSON.parse(fs.readFileSync(path.join(dir, 'engine.json'), 'utf8'))
const files = []
const links = []
async function walk(folder, prefix = '') {
  for (const entry of fs.readdirSync(folder).sort()) {
    if (!prefix && entry === 'engine.json') continue
    const full = path.join(folder, entry)
    const relative = prefix ? `${prefix}/${entry}` : entry
    const stat = fs.lstatSync(full)
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(full)
      if (target.includes('/') || target.includes('\\'))
        throw new Error(`${relative} links outside its folder`)
      links.push({ path: relative, target })
    } else if (stat.isDirectory()) {
      await walk(full, relative)
    } else if (stat.isFile()) {
      const executable = platform !== 'win32' && (stat.mode & 0o111) !== 0
      files.push({
        path: relative,
        sha256: await sha256Of(full),
        size: stat.size,
        mode: executable ? 0o755 : 0o644,
        full
      })
    }
  }
}
if (!packMode) {
  await walk(dir)
  if (!files.some((file) => file.path === engine.smokeTest))
    throw new Error(`${engine.smokeTest} is not in ${dir}`)
}

// ---- R2 (S3 API, SigV4) ------------------------------------------------------------------------
const endpoint = env('R2_ENDPOINT').replace(/\/$/, '')
const bucket = env('R2_BUCKET')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()
const encodeKey = (key) => key.split('/').map(encodeURIComponent).join('/')

function signedRequest(method, key, extraHeaders = {}) {
  const url = new URL(`${endpoint}/${bucket}/${encodeKey(key)}`)
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const day = amzDate.slice(0, 8)
  const headers = {
    host: url.host,
    'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
    'x-amz-date': amzDate,
    ...Object.fromEntries(
      Object.entries(extraHeaders).map(([name, value]) => [name.toLowerCase(), String(value)])
    )
  }
  const signedNames = Object.keys(headers)
    .filter((name) => name !== 'content-length')
    .sort()
  const canonical = [
    method,
    url.pathname,
    '',
    ...signedNames.map((name) => `${name}:${headers[name].trim()}`),
    '',
    signedNames.join(';'),
    'UNSIGNED-PAYLOAD'
  ].join('\n')
  const scope = `${day}/auto/s3/aws4_request`
  const toSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonical).digest('hex')
  ].join('\n')
  const signingKey = ['auto', 's3', 'aws4_request'].reduce(
    (key, part) => hmac(key, part),
    hmac(`AWS4${env('R2_SECRET_ACCESS_KEY')}`, day)
  )
  const signature = createHmac('sha256', signingKey).update(toSign).digest('hex')
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${env('R2_ACCESS_KEY_ID')}/${scope}, SignedHeaders=${signedNames.join(';')}, Signature=${signature}`
  delete headers.host
  return { url, headers }
}

async function exists(key) {
  const { url, headers } = signedRequest('HEAD', key)
  const response = await fetch(url, { method: 'HEAD', headers })
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`HEAD ${key}: HTTP ${response.status}`)
  return true
}

async function getText(key) {
  const { url, headers } = signedRequest('GET', key)
  const response = await fetch(url, { headers })
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`GET ${key}: HTTP ${response.status}`)
  return response.text()
}

async function put(key, body, size, contentType, cacheControl) {
  const { url, headers } = signedRequest('PUT', key, {
    'content-type': contentType,
    'cache-control': cacheControl,
    'content-length': size
  })
  const response = await fetch(url, { method: 'PUT', headers, body, duplex: 'half' })
  if (!response.ok) throw new Error(`PUT ${key}: HTTP ${response.status} ${await response.text()}`)
}

// ---- Sign ---------------------------------------------------------------------------------------
async function writeIndex(indexKey, index, summary) {
  const body = Buffer.from(`${JSON.stringify(index, null, 2)}\n`)
  const privateKey = createPrivateKey({
    key: Buffer.from(env('ENGINE_SIGNING_PRIVATE_KEY'), 'base64'),
    format: 'der',
    type: 'pkcs8'
  })
  const signature = Buffer.from(`${sign(null, body, privateKey).toString('base64')}\n`)
  // The app fetches both and refuses a pair that does not match, so a reader between these two writes
  // only waits for its next check.
  await put(`${indexKey}.sig`, signature, signature.length, 'text/plain', 'public, max-age=60')
  await put(indexKey, body, body.length, 'application/json', 'public, max-age=60')
  console.log(`published ${indexKey} with ${summary}`)
}

async function readIndex(indexKey) {
  const existing = await getText(indexKey)
  const index = existing ? JSON.parse(existing) : { schemaVersion: 1, platform, engines: [] }
  if (index.schemaVersion !== 1 || index.platform !== platform)
    throw new Error(`${indexKey} is not a v1 ${platform} index`)
  return index
}

// ---- Publish the CUDA pack ----------------------------------------------------------------------
if (packMode) {
  const asset = JSON.parse(fs.readFileSync(values.pack, 'utf8')).cuda?.[platform]
  if (
    !asset ||
    // The desktop parser's version rule (SAFE_VERSION in src/shared/performance-pack.ts): a pack it
    // would reject must never reach the signed index.
    typeof asset.version !== 'string' ||
    !/^[a-zA-Z0-9._-]+$/.test(asset.version) ||
    new URL(asset.url).origin !== 'https://runtime.getoffgridai.co' ||
    new URL(asset.url).pathname !== `/desktop/cuda/${platform}/${asset.version}.tar.gz` ||
    !/^[a-f0-9]{64}$/i.test(asset.sha256) ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes <= 0
  )
    throw new Error(`${values.pack} has no valid ${platform} CUDA pack`)
  const performancePack = {
    url: asset.url,
    sha256: asset.sha256,
    bytes: asset.bytes,
    version: asset.version
  }
  if (dryRun) {
    console.log(JSON.stringify(performancePack, null, 2))
    process.exit(0)
  }
  // Advertise only an archive that is already in the store: clients download what the index names.
  const archiveKey = `desktop/cuda/${platform}/${asset.version}.tar.gz`
  if (!(await exists(archiveKey))) throw new Error(`${archiveKey} is not in the store yet`)
  const indexKey = `desktop/engines/${platform}/index-v2.json`
  const index = await readIndex(indexKey)
  if (JSON.stringify(index.performancePack) === JSON.stringify(performancePack)) {
    console.log(`${indexKey} already has CUDA pack ${asset.version}`)
    process.exit(0)
  }
  await writeIndex(indexKey, { ...index, performancePack }, `CUDA pack ${asset.version}`)
  process.exit(0)
}

// ---- Publish ------------------------------------------------------------------------------------
const totalBytes = files.reduce((sum, file) => sum + file.size, 0)
console.log(
  `${engine.id} ${engine.version} for ${platform}: ${files.length} files, ${links.length} links, ${(totalBytes / 1e6).toFixed(0)} MB`
)

const release = {
  id: engine.id,
  version: engine.version,
  // --min-app overrides the floor the pins gave the engine (engine.json minApp, scripts/engine-floors.mjs).
  ...(values['min-app'] || engine.minApp
    ? { minAppVersion: values['min-app'] || engine.minApp }
    : {}),
  ...(engine.requires ? { requires: engine.requires } : {}),
  smokeTest: engine.smokeTest,
  files: files.map(({ full: _full, ...file }) => file),
  ...(links.length ? { links } : {})
}
const indexKey = `desktop/engines/${platform}/${values.index === 'v2' ? 'index-v2.json' : 'index.json'}`

if (dryRun) {
  console.log(JSON.stringify(release, null, 2))
  process.exit(0)
}

const current = await readIndex(indexKey)
// Publishing the same build again changes nothing, so the index (and every app) is left alone.
const published = current.engines.find((item) => item.id === engine.id)
if (published && JSON.stringify(published) === JSON.stringify(release)) {
  console.log(`${indexKey} already has ${engine.id} ${engine.version}`)
  process.exit(0)
}

for (const file of files) {
  const key = `desktop/engines/files/${file.sha256}`
  if (await exists(key)) {
    console.log(`have ${file.path}`)
    continue
  }
  console.log(`upload ${file.path} (${(file.size / 1e6).toFixed(1)} MB)`)
  await put(
    key,
    Readable.toWeb(fs.createReadStream(file.full)),
    file.size,
    'application/octet-stream',
    'public, max-age=31536000, immutable'
  )
}

// Read the index again: another publisher may have written it during the uploads.
const latest = await readIndex(indexKey)
// Fields beside the engines (the CUDA pack) are kept.
const index = {
  ...latest,
  engines: [...latest.engines.filter((item) => item.id !== engine.id), release].sort((a, b) =>
    a.id.localeCompare(b.id)
  )
}
await writeIndex(indexKey, index, `${engine.id} ${engine.version}`)
