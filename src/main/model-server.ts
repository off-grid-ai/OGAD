import { videoGenerationStatus } from './generated-videos/status'
import { dispatchGatewayRoute, proGatewayFeature } from './gateway-routes'
// Off Grid AI local inference gateway — ONE OpenAI-compatible endpoint for every
// modality, on :7878. Any local tool (IDE, app, script) points here and gets the
// on-device models, and so does a phone on the same LAN - Off Grid AI Mobile scans the
// subnet for this port. API keys are optional until enabled in Gateway > API keys.
// Local-only settings mutations and the paired extension retain their own checks.
//
//   GET  /                       -> gateway info + live modality status
//   GET  /v1/models              -> the ACTIVE model per modality (text/vision +
//                                   image/speech/transcription), each tagged with
//                                   a `kind` — what a request would load on demand
//   POST /v1/chat/completions    -> proxied to llama-server (text + vision-in)
//   POST /v1/completions         -> proxied to llama-server
//   POST /v1/embeddings          -> proxied to llama-server
//   POST /v1/audio/transcriptions-> whisper.cpp (speech -> text), multilingual
//   POST /v1/audio/speech        -> Kokoro TTS (text -> speech, WAV)
//   GET  /v1/audio/voices        -> available TTS voice ids (non-standard helper)
//   POST /v1/images/generations  -> diffusion text-to-image (sd-cli / Core ML)
//   POST /v1/images/edits        -> diffusion image-to-image (multipart `image`)
//
// Everything is OpenAI-API-shaped so off-the-shelf SDKs (openai-python,
// openai-node, etc.) work by just pointing base_url at this server. Full
// documentation is served at GET /docs (and lives in docs/API.md).

import http from 'http'
import {
  AIRequestHandle,
  setGatewayRequestKeyName,
  withGatewayRequestScope
} from './ai-request-log'
import { observeAIResponse } from './ai-request-log-http'
import https from 'https'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID, randomBytes, createHash } from 'crypto'
import { getSecret, setSecret, listSecretKeys } from './secrets'
import { getSetting, saveSetting } from './database'
import { authorizeBearer } from './mcp-auth-logic'
import type { GatewayApiKeyContract, GatewayApiKeySettingsContract } from '../shared/ipc-contracts'
import { getActiveTranscription } from './transcription/select'
import { transcriptionRequestOptions } from './model-server/transcription-request'
import * as tts from './tts'
import {
  generateImage,
  imageGenStatus,
  activeImageModel,
  listImageModels,
  type ImageGenParams
} from './imagegen'
import { whisperModel } from './media-text'
import { getActiveModal } from './active-models'
import { modalityForKind } from './active-models-logic'
import { embeddings } from './embeddings'
import { DEFAULT_EMBEDDER } from './embedding-models'
import { docsText, docsHtml, openApiSpec } from './api-docs'
import { handleMcpRequest } from './mcp-server'
import { logActionTokenForDev } from './mcp-auth'
import { llm, type LlmSettings } from './llm'
import { GATEWAY_HOST, GATEWAY_BIND_HOST, GATEWAY_PORT } from '../shared/ports'
import { isPortFree, pickFreePort } from './free-port'
import { retryWithDeadline } from './lib/retry'
import { resolveDims } from './model-server/dimensions'
import { guardProxyStreams } from './stream-guards'
import {
  classifyRef,
  decodeDataUrl,
  stripFileScheme,
  mimeFromExt,
  extForMime,
  toDataUrl
} from './model-server/data-url'
import { errBody, errMeta } from './model-server/errors'
import {
  applyKeepLoaded,
  keepLoadedLimiter,
  keepLoadedPort,
  keepLoadedContextLength,
  keepLoadedServes,
  keptModelIds,
  shutdownKeepLoaded
} from './model-server/keep-loaded'
import { endStreamWithError, openEarlyStream, type EarlyStream } from './model-server/early-stream'
import { handleExtensionBridge, handleExtensionUpgrade } from './extension-bridge/bridge-http'
import { isAsync, matchPollRoute } from './model-server/async-request'
import {
  chatPromptShape,
  sanitizeChatMessages,
  parseDecisionChatMessages
} from './model-server/chat-messages'
import { applyThinkingPayload, requestedThinking } from './llm/chat-payload'
import { parseMultipart } from './model-server/multipart'
import {
  tagLlmEntries,
  modelEntry,
  ollamaMirror,
  specialistModelEntries,
  installedTextModelEntries,
  installedImageModelEntries,
  leadWithActiveChatModel,
  liveChatCapabilities
} from './model-server/models-list'
import { buildGatewayModalities, type GatewayModalities } from './model-server/health'
import { safeProxyResponse } from './model-server/proxy-response'
import { writeDiagnosticLog } from './diagnostics-log'
import { modalityQueue, CHAT_JOB } from './modality-queue/queue'
import { IMAGE_CANCELLED_MESSAGE } from './imagegen/generation-lifecycle'
import { parseRemoteVisionModelId, remoteVisionModelId } from '../shared/remote-vision-server'
import {
  getActiveRemoteVisionServer,
  getActiveRemoteVisionServerForModality
} from './vision/remote-vision-server'
import {
  GATEWAY_LOCAL_IDLE_TIMEOUT_MS,
  GATEWAY_REMOTE_IDLE_TIMEOUT_MS,
  REASONING_BUDGET_AUTO,
  REMOTE_TEAM_CONCURRENCY,
  TEAM_DRAIN_TIMEOUT_MS,
  TEAM_KEEP_AWAKE_GRACE_MS,
  chatRequestTokens
} from '@offgrid/models'
import {
  LimiterFullError,
  UpstreamLimiter,
  limiterRunning,
  setLimiterActivityListener,
  type Release
} from './model-server/upstream-limiter'
import { TeamKeepAwake, type PowerBlocker } from './model-server/keep-awake'
import {
  chatLimiter,
  embedCoalesced,
  teamConcurrency,
  teamLimiter,
  teamMode,
  teamRuntimeStatus
} from './model-server/team-runtimes'
import type { GatewayRuntime } from '@offgrid/models'
import { pipeline } from 'stream'
import { routerModelName } from '../shared/keep-loaded-plan'
import { remoteTextVision } from '../shared/model-settings-rules'
import {
  remoteNativeToolCapability,
  remoteReasoningCapability,
  remoteReasoningFields,
  remoteTextModelProviderError
} from './llm/remote-chat'

const UPSTREAM_HOST = '127.0.0.1'
// The upstream llama-server port is LIVE, not fixed: llm.getPort() moves off LLAMA_SERVER_PORT when
// another app owns it (see llm.prepareModelPort). Read it per-request so the gateway always proxies
// to wherever the engine actually bound. (LLAMA_SERVER_PORT stays the PREFERRED default in llm.)
const upstreamPort = (): number => llm.getPort()
const MAX_UPLOAD = 200 * 1024 * 1024 // 200MB upload cap (audio / init image)

let server: http.Server | null = null

// ─── Team mode ───────────────────────────────────────────────────────────────
// 'single' (the default) serves one person exactly as the gateway always has: every chat holds the
// app-wide chat job for its whole stream. 'team' serves several clients: a chat for the model that
// is already loaded is admitted by a limiter sized to llama-server's slots, a remote model has its
// own limiter, and only a model swap or load goes through the app-wide queue.
const localAgents = new Map<number, http.Agent>()
/** One connection pool per llama-server port, wide enough for every slot and its waiters. Not
 *  keep-alive: llama-server closes the connection after a streamed reply, so a reused socket fails
 *  with ECONNRESET and the request waits out a one-second retry (measured 2026-10-19: every
 *  other sequential request). A new loopback connection costs well under a millisecond. */
function localAgent(port: number): http.Agent {
  let agent = localAgents.get(port)
  if (!agent) {
    agent = new http.Agent({ keepAlive: false, maxSockets: 64 })
    localAgents.set(port, agent)
  }
  return agent
}
const remoteAgents = {
  http: new http.Agent({ keepAlive: true, maxSockets: REMOTE_TEAM_CONCURRENCY }),
  https: new https.Agent({ keepAlive: true, maxSockets: REMOTE_TEAM_CONCURRENCY })
}

// The gateway owns its credentials. Reuse the OS-encrypted secret store; do not
// put credentials in generic settings, return stored hashes to IPC, or log them.
const GATEWAY_KEYS_SECRET = 'gateway:api-keys'
// Whether keys are required is not a credential. A plain copy lets the gateway decide what to do
// when the keychain cannot be read: refuse when keys are required, serve when they are not.
const GATEWAY_KEYS_REQUIRED_SETTING = 'gatewayApiKeysRequired'
const GATEWAY_KEYS_LOCKED = 'API key storage is locked. Unlock system key storage and try again.'
type StoredGatewayKeys = { enabled: boolean; keys: (GatewayApiKeyContract & { digest: string })[] }

function recordGatewayKeysRequired(enabled: boolean): void {
  if (getSetting<boolean | null>(GATEWAY_KEYS_REQUIRED_SETTING, null) !== enabled)
    saveSetting(GATEWAY_KEYS_REQUIRED_SETTING, enabled)
}

function readGatewayKeys(): StoredGatewayKeys {
  const raw = getSecret(GATEWAY_KEYS_SECRET)
  if (raw === null) {
    if (listSecretKeys().includes(GATEWAY_KEYS_SECRET)) throw new Error(GATEWAY_KEYS_LOCKED)
    return { enabled: false, keys: [] }
  }
  const value = JSON.parse(raw) as StoredGatewayKeys
  if (
    typeof value.enabled !== 'boolean' ||
    !Array.isArray(value.keys) ||
    value.keys.some(
      (key) =>
        typeof key.id !== 'string' ||
        typeof key.name !== 'string' ||
        typeof key.digest !== 'string' ||
        !/^[a-f0-9]{64}$/.test(key.digest) ||
        (key.expiresAt !== null && !Number.isFinite(key.expiresAt)) ||
        (key.revokedAt !== null && !Number.isFinite(key.revokedAt))
    )
  )
    throw new Error('API key storage could not be read.')
  recordGatewayKeysRequired(value.enabled)
  return value
}

// Team mode keeps the decrypted key digests in memory instead of reading the keychain on every
// request. Every change to the keys goes through writeGatewayKeys, which drops the copy.
let cachedGatewayKeys: StoredGatewayKeys | null = null

function gatewayKeysForRequest(): StoredGatewayKeys {
  if (!teamMode()) {
    cachedGatewayKeys = null
    return readGatewayKeys()
  }
  return (cachedGatewayKeys ??= readGatewayKeys())
}

function writeGatewayKeys(value: StoredGatewayKeys): void {
  cachedGatewayKeys = null
  if (!setSecret(GATEWAY_KEYS_SECRET, JSON.stringify(value))) {
    throw new Error('API keys require system encryption. Unlock system key storage and try again.')
  }
  recordGatewayKeysRequired(value.enabled)
}

export function gatewayApiKeySettings(): GatewayApiKeySettingsContract {
  const state = readGatewayKeys()
  return { enabled: state.enabled, keys: state.keys.map(({ digest: _digest, ...key }) => key) }
}

export function setGatewayApiKeyRequired(enabled: boolean): GatewayApiKeySettingsContract {
  if (typeof enabled !== 'boolean') throw new Error('Authentication must be on or off.')
  const state = readGatewayKeys()
  state.enabled = enabled
  writeGatewayKeys(state)
  return gatewayApiKeySettings()
}

export function createGatewayApiKey(
  name: string,
  expiresAt: number | null,
  replaceId?: string
): { key: string; settings: GatewayApiKeySettingsContract } {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 80)
    throw new Error('Enter a key name of 1 to 80 characters.')
  const now = Date.now()
  if (
    expiresAt !== null &&
    (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > 8640000000000000)
  )
    throw new Error('Choose an expiry date in the future.')
  const state = readGatewayKeys()
  if (replaceId !== undefined) {
    const previous = state.keys.find((key) => key.id === replaceId)
    if (!previous || previous.revokedAt !== null) throw new Error('This key is no longer active.')
    previous.revokedAt = now
  }
  const key = `ogad_${randomBytes(32).toString('hex')}`
  state.keys.push({
    id: randomUUID(),
    name: name.trim(),
    prefix: key.slice(0, 13),
    digest: createHash('sha256').update(key).digest('hex'),
    createdAt: now,
    expiresAt,
    revokedAt: null,
    lastUsedAt: null
  })
  state.enabled = true
  writeGatewayKeys(state)
  return { key, settings: gatewayApiKeySettings() }
}

export function revokeGatewayApiKey(id: string): GatewayApiKeySettingsContract {
  const state = readGatewayKeys()
  const key = state.keys.find((key) => key.id === id)
  if (!key) throw new Error('API key not found.')
  key.revokedAt ??= Date.now()
  writeGatewayKeys(state)
  return gatewayApiKeySettings()
}

function authorizeGateway(req: http.IncomingMessage): boolean {
  let state: StoredGatewayKeys
  try {
    state = gatewayKeysForRequest()
  } catch (error) {
    // A locked keychain serves only when keys were last recorded as not required. A store from a
    // build that never recorded it counts as required until it is next read.
    if (
      error instanceof Error &&
      error.message === GATEWAY_KEYS_LOCKED &&
      getSetting<boolean | null>(GATEWAY_KEYS_REQUIRED_SETTING, null) === false
    )
      return true
    throw error
  }
  if (!state.enabled) return true
  const header = req.headers.authorization
  // Preserve the existing strict Bearer parser and constant-time comparison.
  const credential = header?.match(/^Bearer[ \t]+([^\s]+)$/i)?.[1]
  if (!credential) return false
  const digest = createHash('sha256').update(credential).digest('hex')
  const now = Date.now()
  let match: StoredGatewayKeys['keys'][number] | undefined
  for (const key of state.keys) {
    if (
      authorizeBearer(`Bearer ${digest}`, key.digest) &&
      key.revokedAt === null &&
      (key.expiresAt === null || now < key.expiresAt)
    )
      match = key
  }
  if (!match) return false
  // The request log names the key that sent this request (its name, never the key).
  setGatewayRequestKeyName(match.name)
  // Limit disk writes without caching credentials: revocation applies on the next request.
  if (match.lastUsedAt === null || now - match.lastUsedAt >= 60_000) {
    match.lastUsedAt = now
    writeGatewayKeys(state)
  }
  return true
}

async function liveGatewayModalities(imageAvailable: boolean): Promise<GatewayModalities> {
  let installed: string[] = []
  try {
    const models = await import('./models-manager')
    installed = await models.listInstalled()
  } catch {
    /* unavailable model registry means optional modalities are not ready */
  }
  const transcription = getActiveModal('transcription')
  const speech = getActiveModal('speech')
  // Each modality is ready on this Mac or on the remote server the person chose for it.
  const chat = llm.modelsExist() || !!getActiveRemoteVisionServer()
  return buildGatewayModalities({
    chat,
    vision: chat && llm.hasVision(),
    embeddings: true,
    transcription:
      !!getActiveRemoteVisionServerForModality('transcription') ||
      !!whisperModel() ||
      (!!transcription && installed.includes(transcription)),
    speech:
      !!getActiveRemoteVisionServerForModality('voice') ||
      (!!speech && installed.includes(speech)),
    video: videoGenerationStatus({ localOnly: true }).available,
    image: imageAvailable
  })
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  // A stream that already answered (it was waiting its turn) reports the failure in-stream.
  if (res.headersSent) return endStreamWithError(res, body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// ─── Async requests & polling ────────────────────────────────────────────────
// Every modality can run asynchronously: the POST returns 202 with a request
// resource (`request_id` + a RESTful poll URL) and the work runs in the
// background. Poll it RESTfully with GET on the resource — either the canonical
// `/v1/requests/{id}` or the per-collection resource (e.g. `/v1/images/{id}`).
// Default behavior stays synchronous; opt in with `?async=true`, body
// `"async": true`, header `X-Async: true`, or `Prefer: respond-async`.
//
// We model the long operation as a *resource you read*, not a `/poll` verb —
// that's the RESTful async request-reply pattern.

type ReqStatus = 'queued' | 'running' | 'completed' | 'failed'

interface ApiRequest {
  id: string
  kind: string // chat | embedding | transcription | speech | image
  collection: string // RESTful base path the resource lives under
  status: ReqStatus
  created_at: number
  updated_at: number
  result?: unknown
  error?: { message: string; type: string }
  progress?: { step: number; total: number }
  controller?: AbortController
}

const requests = new Map<string, ApiRequest>()
const REQUESTS_MAX = 500
function createRequest(id: string, kind: string, collection: string): ApiRequest {
  if (requests.size >= REQUESTS_MAX) {
    const oldest = [...requests.values()].find(
      (item) => item.status === 'completed' || item.status === 'failed'
    )?.id
    if (oldest) requests.delete(oldest)
  }
  const now = Date.now()
  const r: ApiRequest = { id, kind, collection, status: 'queued', created_at: now, updated_at: now }
  if (kind === 'image') r.controller = new AbortController()
  requests.set(id, r)
  return r
}

/** Move a request through running → completed/failed around the work promise. */
function settle<T>(r: ApiRequest, work: Promise<T>): Promise<T> {
  r.status = 'running'
  r.updated_at = Date.now()
  return work.then(
    (result) => {
      if (r.controller?.signal.aborted) throw new Error(IMAGE_CANCELLED_MESSAGE)
      r.status = 'completed'
      r.result = result
      r.updated_at = Date.now()
      return result
    },
    (e) => {
      const { type, message } = errMeta(e)
      r.status = 'failed'
      // Image cancellation aborts the controller.
      r.error = r.controller?.signal.aborted
        ? { message: IMAGE_CANCELLED_MESSAGE, type: 'cancelled' }
        : { message, type }
      r.updated_at = Date.now()
      throw e
    }
  )
}

/** Cancel only the named image request. Completed and previously cancelled requests are safe to repeat. */
function handleCancel(res: http.ServerResponse, id: string): void {
  const r = requests.get(id)
  if (!r) return json(res, 404, errBody(`No request with id '${id}'.`, 'not_found'))
  if (!r.controller)
    return json(res, 409, errBody('This request cannot be cancelled.', 'not_cancellable'))
  if (r.status === 'queued' || r.status === 'running') {
    r.status = 'failed'
    r.error = { message: IMAGE_CANCELLED_MESSAGE, type: 'cancelled' }
    r.updated_at = Date.now()
    r.controller.abort()
  }
  json(res, 200, { request_id: r.id, status: r.status, cancelled: r.error?.type === 'cancelled' })
}

/** 202 Accepted with the request resource + Location for polling. */
function dispatchAsync(res: http.ServerResponse, r: ApiRequest): void {
  const pollUrl = `${r.collection}/${r.id}`
  res.setHeader('Location', pollUrl)
  json(res, 202, {
    request_id: r.id,
    object: 'request',
    kind: r.kind,
    status: r.status,
    poll_url: pollUrl,
    created_at: r.created_at
  })
}

/** GET a request resource — the RESTful poll. */
function handlePoll(res: http.ServerResponse, id: string): void {
  const r = requests.get(id)
  if (!r) {
    json(res, 404, errBody(`No request with id '${id}'.`, 'not_found'))
    return
  }
  const body: Record<string, unknown> = {
    request_id: r.id,
    object: 'request',
    kind: r.kind,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    poll_url: `${r.collection}/${r.id}`
  }
  if (r.status === 'completed') body.result = r.result
  if (r.status === 'failed') body.error = r.error
  if (r.progress) body.progress = r.progress
  json(res, 200, body)
}

// Proxy a request to the local llama-server (response streaming preserved).
// If `bodyOverride` is supplied, that buffer is sent as the request body (used
// when we rewrite chat messages to inline remote images); otherwise the incoming
// request is piped straight through.
//
// When a buffer is supplied the request is replayable, so on a connection error
// (llama-server briefly down while it reloads after image generation) we wait and
// retry until `retryUntil` rather than failing the caller with a 502. Piped
// (streamed) requests can't be replayed, so they fail fast. The wait-and-retry
// loop is the shared `retryWithDeadline` helper.
function proxyToLlama(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyOverride?: Buffer,
  retryUntil = 0,
  activity?: AIRequestHandle,
  targetPort?: number,
  pooled = false,
  /** Team mode: the slot's turn, ended once llama-server has finished with the request (not as
   *  soon as the client leaves, while the engine may still hold the slot). */
  release?: Release,
  /** A stream that already answered keeps its connection alive until the engine answers: a long
   *  prompt or a router loading the model can take minutes. */
  early?: EarlyStream | null
): void {
  const headers = { ...req.headers, host: `${UPSTREAM_HOST}:${targetPort ?? upstreamPort()}` }
  let responded = false
  delete headers.authorization
  if (bodyOverride) {
    headers['content-length'] = String(bodyOverride.length)
    delete headers['transfer-encoding']
  }
  // Team mode: a client that leaves while llama-server is still reading the prompt cancels the
  // upstream request at once, so the slot goes to the next request in line.
  let upstreamRequest: http.ClientRequest | null = null
  // A team-mode stream carries about a dozen 'close' listeners, each its own: the request log,
  // the slot's release, the upstream cancel, the stream guards and the pipeline's own. Bounded per
  // response, so the default warning at eleven would only be noise.
  if (pooled) res.setMaxListeners(20)
  if (pooled)
    res.once('close', () => {
      if (!res.writableEnded) upstreamRequest?.destroy()
    })
  // One attempt: resolves once the upstream response is piped through, rejects
  // on a connection error (the only transient failure this proxy retries).
  const attempt = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const proxyReq = http.request(
        {
          hostname: UPSTREAM_HOST,
          port: targetPort ?? upstreamPort(),
          path: req.url,
          method: req.method,
          headers,
          ...(pooled ? { agent: localAgent(targetPort ?? upstreamPort()) } : {})
        },
        (proxyRes) => {
          responded = true
          early?.stop()
          const safeResponse = safeProxyResponse(proxyRes.statusCode, proxyRes.headers)
          if (res.headersSent && safeResponse.statusCode !== 200) {
            // The stream already answered while it waited: pass the engine's error on in-stream.
            let raw = ''
            proxyRes.on('data', (chunk) => (raw += String(chunk)))
            proxyRes.on('end', () => {
              let parsed: unknown
              try {
                parsed = JSON.parse(raw)
              } catch {
                parsed = errBody(raw.slice(0, 500) || 'The model server failed.', 'upstream_error')
              }
              activity?.finish(undefined, new Error(raw.slice(0, 200)))
              endStreamWithError(res, parsed)
            })
            resolve()
            return
          }
          if (!res.headersSent) res.writeHead(safeResponse.statusCode, safeResponse.headers)
          // Guard both ends BEFORE piping: a mid-stream reset from llama-server (or a client
          // disconnect) emits 'error' on these streams, and with no listener that becomes an
          // uncaught exception that crashes the main process. Does not re-settle this promise —
          // it has already resolved once piping begins.
          guardProxyStreams(proxyRes, res)
          if (pooled) {
            // The client left before llama-server answered: drop the answer, which frees the slot.
            if (res.destroyed) {
              proxyRes.destroy()
              resolve()
              return
            }
            // Team mode: tokens go out as they arrive, and a slow client slows its own stream only.
            res.flushHeaders()
            res.socket?.setNoDelay(true)
            observeAIResponse(proxyRes, res, activity, { deferred: true })
            pipeline(proxyRes, res, () => {})
          } else {
            observeAIResponse(proxyRes, res, activity)
            proxyRes.pipe(res)
          }
          resolve()
        }
      )
      proxyReq.on('error', reject)
      // The engine is done with this request (answered, or cancelled with its client): the slot
      // is free. A connection error before any answer is retried and keeps the turn.
      if (release)
        proxyReq.once('close', () => {
          if (responded || res.destroyed) release()
        })
      // Team mode: a request with no bytes either way for a long time is cut, so a wedged engine
      // cannot hold a slot for ever. An idle limit: a long reply that keeps streaming is never cut.
      if (pooled)
        proxyReq.setTimeout(GATEWAY_LOCAL_IDLE_TIMEOUT_MS, () =>
          proxyReq.destroy(new Error('llama-server went quiet.'))
        )
      upstreamRequest = proxyReq
      if (bodyOverride) {
        proxyReq.end(bodyOverride)
      } else {
        req.pipe(proxyReq)
      }
    })
  // Piped requests aren't replayable, so they fail fast (replayable=false).
  retryWithDeadline(attempt, {
    deadlineMs: retryUntil,
    replayable: !!bodyOverride,
    // A client that has gone is not waited for (team mode cancels its upstream request).
    ...(pooled ? { isTransient: () => !res.destroyed } : {})
  }).catch(() => {
    release?.()
    activity?.finish(undefined, new Error('Local model not ready'))
    json(res, 502, errBody('Local model not ready (llama-server unavailable).', 'upstream_error'))
  })
}

/** Forward an inventory-selected remote model through the Desktop connection that owns it.
 * Mobile sees the stable inventory id, while the provider must receive its native model id. */
function proxyToSelectedRemote(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  activity?: AIRequestHandle,
  pooled = false
): boolean {
  const requested = typeof body.model === 'string' ? parseRemoteVisionModelId(body.model) : null
  if (!requested) return false
  const remote = getActiveRemoteVisionServer()
  if (!remote || requested.serverId !== remote.id || requested.modelId !== remote.model) {
    activity?.finish(undefined, new Error('The selected remote model is not active.'))
    json(res, 400, errBody('The selected remote model is not active.', 'invalid_request_error'))
    return true
  }

  void forwardToRemote(res, body, remote, activity, pooled)
  return true
}

/** Send the request to the remote provider, with its reasoning control translated for it. */
async function forwardToRemote(
  res: http.ServerResponse,
  body: Record<string, unknown>,
  remote: NonNullable<ReturnType<typeof getActiveRemoteVisionServer>>,
  activity?: AIRequestHandle,
  pooled = false
): Promise<void> {
  const target = new URL(`${remote.endpoint.replace(/\/+$/, '')}/chat/completions`)
  const thinkingRequested = requestedThinking(body)
  const forwarded: Record<string, unknown> = { ...body, model: remote.model }
  // The phone and the browser send llama.cpp controls to this gateway. OpenRouter needs its own
  // reasoning control, built exactly as Chat builds it (remoteReasoningFields): a model whose
  // reasoning is mandatory is never told to switch it off.
  if (remote.provider === 'openrouter' && thinkingRequested !== undefined) {
    const budget =
      typeof body.reasoning_budget_tokens === 'number' && body.reasoning_budget_tokens > 0
        ? body.reasoning_budget_tokens
        : REASONING_BUDGET_AUTO
    delete forwarded.chat_template_kwargs
    delete forwarded.reasoning_format
    delete forwarded.reasoning_budget_tokens
    delete forwarded.reasoning
    Object.assign(
      forwarded,
      remoteReasoningFields(thinkingRequested, budget, await remoteReasoningCapability(remote))
    )
  }
  writeDiagnosticLog('gateway', 'remote_chat.thinking_control', {
    requestId: String(res.getHeader('X-Request-Id') ?? ''),
    provider: remote.provider,
    thinkingRequested: thinkingRequested ?? null,
    control:
      remote.provider === 'openrouter' && thinkingRequested !== undefined
        ? thinkingRequested
          ? 'openrouter-on'
          : 'openrouter-off'
        : 'passthrough'
  })
  const payload = Buffer.from(JSON.stringify(forwarded))
  activity?.update({ model: remote.model, backend: 'Remote', effectiveRequest: forwarded })
  const client = target.protocol === 'https:' ? https : http
  const proxyReq = client.request(
    target,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(payload.length),
        ...(remote.apiKey ? { authorization: `Bearer ${remote.apiKey}` } : {})
      },
      ...(pooled
        ? { agent: target.protocol === 'https:' ? remoteAgents.https : remoteAgents.http }
        : {})
    },
    (proxyRes) => {
      // Team mode: the client left while the provider was thinking: drop the answer.
      if (pooled && res.destroyed) {
        proxyRes.destroy()
        return
      }
      observeAIResponse(proxyRes, res, activity, { deferred: pooled })
      const status = proxyRes.statusCode ?? 502
      let providerErrorBody = ''
      if (status >= 400) {
        proxyRes.on('data', (chunk: Buffer | string) => {
          if (providerErrorBody.length >= 4_096) return
          providerErrorBody += chunk.toString().slice(0, 4_096 - providerErrorBody.length)
        })
        proxyRes.on('end', () => {
          const error = remoteTextModelProviderError(status, providerErrorBody)
          writeDiagnosticLog(
            'gateway',
            'remote_chat.provider_failed',
            {
              requestId: String(res.getHeader('X-Request-Id') ?? ''),
              provider: remote.provider,
              model: remote.model,
              status,
              error: error.message
            },
            status >= 500 ? 'error' : 'warn'
          )
        })
      }
      const safeResponse = safeProxyResponse(proxyRes.statusCode, proxyRes.headers)
      res.writeHead(safeResponse.statusCode, safeResponse.headers)
      guardProxyStreams(proxyRes, res)
      if (pooled) {
        // Team mode: tokens go out as they arrive, and a slow client slows its own stream only.
        res.flushHeaders()
        res.socket?.setNoDelay(true)
        pipeline(proxyRes, res, () => {})
      } else proxyRes.pipe(res)
    }
  )
  if (pooled) {
    // Team mode: a client that leaves cancels the provider request (it stops spending tokens and
    // frees its pooled connection), and a provider silent for minutes is cut.
    res.once('close', () => {
      if (!res.writableEnded) proxyReq.destroy()
    })
    proxyReq.setTimeout(GATEWAY_REMOTE_IDLE_TIMEOUT_MS, () =>
      proxyReq.destroy(new Error('The remote model went quiet.'))
    )
  }
  proxyReq.on('error', (error) => {
    activity?.finish(undefined, error)
    // Team mode cancelled it because the client left: nothing failed and nobody is listening.
    if (pooled && res.destroyed) return
    const errorCode = (error as NodeJS.ErrnoException).code
    writeDiagnosticLog(
      'gateway',
      'remote_chat.connection_failed',
      {
        requestId: String(res.getHeader('X-Request-Id') ?? ''),
        provider: remote.provider,
        model: remote.model,
        error: error.message,
        errorCode: typeof errorCode === 'string' ? errorCode : undefined
      },
      'error'
    )
    if (!res.headersSent) {
      json(res, 502, errBody('Remote model connection failed.', 'upstream_error'))
    } else {
      res.end()
    }
  })
  proxyReq.end(payload)
}

// Fetch an image reference into a Buffer. Accepts data: URLs, http(s):// URLs,
// and file:// / bare local paths. Matches OpenRouter's "URLs preferred, base64
// for local files" convention so the same payloads work against this gateway.
function fetchImage(ref: string): Promise<{ data: Buffer; mime: string }> {
  const url = ref.trim()
  const kind = classifyRef(url)
  if (kind === 'data') {
    return Promise.resolve(decodeDataUrl(url))
  }
  if (kind === 'http') {
    const client = url.startsWith('https://') ? https : http
    return new Promise((resolve, reject) => {
      const r = client.get(url, (resp) => {
        if ((resp.statusCode || 0) >= 400) {
          reject(new Error(`fetch ${url} -> HTTP ${resp.statusCode}`))
          resp.resume()
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        resp.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_UPLOAD) {
            reject(new Error('remote image too large'))
            resp.destroy()
            return
          }
          chunks.push(c)
        })
        resp.on('end', () =>
          resolve({
            data: Buffer.concat(chunks),
            mime: String(resp.headers['content-type'] || 'image/png')
          })
        )
      })
      r.on('error', reject)
    })
  }
  const p = stripFileScheme(url)
  const mime = mimeFromExt(path.extname(p).slice(1))
  return fs.promises.readFile(p).then((data) => ({ data, mime }))
}

function readBody(req: http.IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > cap) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, MAX_UPLOAD)
  if (!body.length) return {}
  return JSON.parse(body.toString('utf8'))
}

// Chat message sanitization (Gemma system-message ordering) lives in
// ./model-server/chat-messages (sanitizeChatMessages), imported above.

// ─── Text(+image) → text (chat, proxied) ─────────────────────────────────────
// Walk an OpenAI chat body and replace any remote/file image_url with an inlined
// base64 data URL (llama-server only accepts data URLs). Returns true if changed.
async function inlineChatImages(body: unknown): Promise<boolean> {
  if (!body || typeof body !== 'object') return false
  const messages = (body as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return false
  let changed = false
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (!part || typeof part !== 'object') continue
      const p = part as { type?: string; image_url?: { url?: string } }
      const url = p.type === 'image_url' ? p.image_url?.url : undefined
      if (url && !url.startsWith('data:')) {
        const { data, mime } = await fetchImage(url)
        p.image_url!.url = toDataUrl(data, mime)
        changed = true
      }
    }
  }
  return changed
}

// Run a modality op either sync (await + media-specific responder) or async
// (202 + background work, pollable). `run` returns the canonical JSON result
// that's both stored for polling and (for JSON modalities) returned inline.
async function serve(
  res: http.ServerResponse,
  rid: string,
  kind: string,
  collection: string,
  asyncFlag: boolean,
  run: (signal?: AbortSignal) => Promise<unknown>,
  syncRespond: (result: unknown) => void
): Promise<void> {
  const teamRuntime = TEAM_SERVE_RUNTIME[kind]
  const work = teamRuntime && teamMode() ? onTeamTurn(teamRuntime, res, asyncFlag, run) : run
  const r = createRequest(rid, kind, collection)
  if (asyncFlag) {
    settle(r, work(r.controller?.signal)).catch(() => {}) // errors captured on the request resource
    dispatchAsync(res, r)
    return
  }
  // Team mode: a client that leaves stops its transcription or speech too, so the lane or voice
  // worker goes to the next request (images already stop through their own controller).
  const gone = teamRuntime && teamMode() && !r.controller ? new AbortController() : undefined
  const cancelDisconnectedImage = (): void => {
    if (res.writableEnded) return
    r.controller?.abort()
    gone?.abort(new Error('The client disconnected.'))
  }
  if (r.controller || gone) res.once('close', cancelDisconnectedImage)
  try {
    const result = await settle(r, work(r.controller?.signal ?? gone?.signal))
    syncRespond(result)
  } catch (e) {
    const { status, type, message } = errMeta(e)
    json(res, status, errBody(message, type))
  } finally {
    res.off('close', cancelDisconnectedImage)
  }
}

/** The runtime each media kind takes its team-mode turn on (chat and embeddings admit themselves). */
const TEAM_SERVE_RUNTIME: Record<string, GatewayRuntime | undefined> = {
  image: 'image',
  transcription: 'transcription',
  speech: 'speech'
}

/** Team mode: `run` waits for a turn on the runtime first. A sync request whose client leaves
 *  while waiting gives its place up; one refused past the line gets 429 with Retry-After. */
function onTeamTurn<T>(
  runtime: GatewayRuntime,
  res: http.ServerResponse,
  asyncFlag: boolean,
  run: (signal?: AbortSignal) => Promise<T>
): (signal?: AbortSignal) => Promise<T> {
  return async (signal) => {
    const gone = new AbortController()
    const leave = (): void => {
      if (!res.writableEnded) gone.abort(new Error('The client disconnected.'))
    }
    if (!asyncFlag) res.once('close', leave)
    let release: Release
    try {
      release = await teamLimiter(runtime).acquire(gone.signal)
    } catch (error) {
      if (error instanceof LimiterFullError && !res.headersSent)
        res.setHeader('Retry-After', String(error.retryAfterSeconds))
      throw error
    } finally {
      res.off('close', leave)
    }
    try {
      return await run(signal)
    } finally {
      release()
    }
  }
}

/** Merge the request id into a JSON result body (sync responder for JSON ops). */
function jsonWithId(res: http.ServerResponse, rid: string, result: unknown): void {
  json(res, 200, { request_id: rid, ...(result as Record<string, unknown>) })
}

// Non-streaming chat call to llama-server returning parsed JSON (used for async
// chat). Retries through a brief reload window like the streaming proxy does,
// via the shared `retryWithDeadline` helper. Only a connection error is
// transient; an HTTP >= 400 answer (or a parse failure) is the engine's real
// reply and is never retried - so those attempt-rejections are tagged fatal.
function callLlamaJson(
  bodyObj: Record<string, unknown>,
  retryUntil: number,
  targetPort?: number,
  pooled = false
): Promise<unknown> {
  const payload = Buffer.from(JSON.stringify({ ...bodyObj, stream: false }))
  // One attempt. A connection ('error') rejection is left un-tagged (transient);
  // an HTTP-error or parse rejection is tagged `fatal` so it is not replayed.
  const attempt = (): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const upstream = http.request(
        {
          hostname: UPSTREAM_HOST,
          port: targetPort ?? upstreamPort(),
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
          ...(pooled ? { agent: localAgent(targetPort ?? upstreamPort()) } : {})
        },
        (resp) => {
          const chunks: Buffer[] = []
          resp.on('data', (c: Buffer) => chunks.push(c))
          resp.on('end', () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              if ((resp.statusCode || 0) >= 400) {
                const err = new Error(parsed?.error?.message || 'upstream error') as Error & {
                  status?: number
                  fatal?: boolean
                }
                err.status = resp.statusCode
                err.fatal = true
                reject(err)
              } else resolve(parsed)
            } catch (e) {
              ;(e as { fatal?: boolean }).fatal = true
              reject(e)
            }
          })
        }
      )
      upstream.on('error', reject)
      upstream.end(payload)
    })
  return retryWithDeadline(attempt, {
    deadlineMs: retryUntil,
    isTransient: (err) => !(err as { fatal?: boolean }).fatal
  }).catch((err) => {
    // A transient failure that outlived the deadline surfaces as the 502 the
    // caller previously saw; fatal errors keep their own status.
    if ((err as { fatal?: boolean }).fatal) throw err
    const e = new Error('Local model not ready (llama-server unavailable).') as Error & {
      status?: number
    }
    e.status = 502
    throw e
  })
}

async function handleSpecialistChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rid: string,
  body: Record<string, unknown>
): Promise<boolean> {
  if (typeof body.model !== 'string') return false
  const { desktopCatalog, listInstalled } = await import('./models-manager')
  const model = (await desktopCatalog()).find(
    (entry) => entry.id === body.model && entry.kind === 'computer_use'
  )
  if (!model) return false
  if (!(await listInstalled()).includes(model.id)) {
    json(res, 404, errBody('The requested specialist is not installed.', 'not_found'))
    return true
  }
  res.setHeader('X-Request-Id', rid)
  const activity = new AIRequestHandle({
    modality: 'text',
    source: 'API specialist',
    model: model.id,
    request: body
  })
  try {
    if (model.tags?.includes('Decision')) {
      let input: ReturnType<typeof parseDecisionChatMessages>
      try {
        input = parseDecisionChatMessages(body.messages)
      } catch (error) {
        activity.finish(undefined, error)
        json(res, 400, errBody((error as Error).message, 'invalid_request_error'))
        return true
      }
      const { decisionRuntime } = await import('./accessibility/decision-runtime')
      const controller = new AbortController()
      const abort = (): void => {
        if (!res.writableEnded) controller.abort()
      }
      const asyncRequest = isAsync(req, body)
      if (!asyncRequest) res.once('close', abort)
      // Team mode: decisions take turns per runtime; a Decider llama-server with slots runs
      // several at once, Kev one forward pass at a time.
      const team = teamMode()
      const { isKevModel } = await import('./models-manager')
      const decide = async (): Promise<unknown> => {
          try {
            await decisionRuntime.start(model.id)
            if (controller.signal.aborted) throw new Error('Decision request cancelled.')
            if (decisionRuntime.activeModelId !== model.id)
              throw new Error('The requested decision model is not ready.')
            const decision = await decisionRuntime.decide(
              input.context,
              input.question,
              input.options,
              controller.signal,
              team
            )
            const result = {
              id: `chatcmpl-${rid}`,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: model.id,
              choices: [
                {
                  index: 0,
                  message: { role: 'assistant', content: JSON.stringify(decision) },
                  finish_reason: 'stop'
                }
              ]
            }
            activity.finish(result)
            return result
          } catch (error) {
            activity.finish(undefined, error)
            throw error
          } finally {
            res.off('close', abort)
          }
        }
      await serve(
        res,
        rid,
        'chat',
        '/v1/chat/completions',
        asyncRequest,
        team
          ? onTeamTurn(isKevModel(model.id) ? 'kev' : 'decision', res, asyncRequest, decide)
          : decide,
        (value) => {
          if (res.destroyed) return
          const result = value as {
            id: string
            created: number
            model: string
            choices: { message: { content: string } }[]
          }
          if (body.stream === true) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
            const chunk = {
              id: result.id,
              object: 'chat.completion.chunk',
              created: result.created,
              model: result.model
            }
            res.write(
              `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: result.choices[0]!.message.content }, finish_reason: null }] })}\n\n`
            )
            res.end(
              `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`
            )
          } else jsonWithId(res, rid, result)
        }
      )
    } else {
      const { grounderRuntime } = await import('./vision/grounder-runtime')
      const connection = await grounderRuntime.connection(model.id)
      if (res.destroyed) return true
      await inlineChatImages(body)
      sanitizeChatMessages(body)
      activity.update({ backend: connection.computeBackend ?? 'Unknown', effectiveRequest: body })
      const port = Number(new URL(connection.endpoint).port)
      const team = teamMode()
      if (isAsync(req, body)) {
        const ground = async (): Promise<unknown> => {
            try {
              const result = await callLlamaJson(body, Date.now() + 45_000, port, team)
              activity.finish(result)
              return result
            } catch (error) {
              activity.finish(undefined, error)
              throw error
            }
          }
        await serve(
          res,
          rid,
          'chat',
          '/v1/chat/completions',
          true,
          team ? onTeamTurn('grounder', res, true, ground) : ground,
          () => {}
        )
      } else if (team) {
        // Team mode: one turn per grounder slot, pooled connections, disconnect frees the slot.
        const release = await admitTeamRequest(teamLimiter('grounder'), res, 0, 'caller')
        if (!release) return true
        proxyToLlama(
          req,
          res,
          Buffer.from(JSON.stringify(body)),
          Date.now() + 45_000,
          activity,
          port,
          true,
          release
        )
      } else
        proxyToLlama(
          req,
          res,
          Buffer.from(JSON.stringify(body)),
          Date.now() + 45_000,
          activity,
          port
        )
    }
  } catch (error) {
    activity.finish(undefined, error)
    if (!res.headersSent && !res.destroyed) {
      const failure = errMeta(error)
      json(res, failure.status, errBody(failure.message, failure.type))
    }
  }
  return true
}

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rid: string
): Promise<void> {
  let buf: Buffer
  try {
    buf = await readBody(req, MAX_UPLOAD)
  } catch {
    json(res, 413, errBody('Request too large.'))
    return
  }
  let body: Record<string, unknown>
  let forward: Buffer = buf
  try {
    const parsed: unknown = JSON.parse(buf.toString('utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      json(res, 400, errBody('Invalid JSON body.'))
      return
    }
    body = parsed as Record<string, unknown>
  } catch {
    json(res, 400, errBody('Invalid JSON body.'))
    return
  }

  try {
    if (await handleSpecialistChat(req, res, rid, body)) return
  } catch (error) {
    const failure = errMeta(error)
    json(res, failure.status, errBody(failure.message, failure.type))
    return
  }
  if (typeof body.model === 'string' && keepLoadedServes(body.model))
    return handleKeptModelChat(req, res, rid, body, buf)
  if (teamMode()) return handleTeamChat(req, res, rid, body, buf)
  // A streaming chat for a model here answers at once and says what it waits for (its turn, a
  // model loading) instead of staying silent until its first token.
  const requestedModel = typeof body.model === 'string' ? body.model : ''
  const early =
    body.stream === true && !parseRemoteVisionModelId(requestedModel) && !isAsync(req, body)
      ? openEarlyStream(res, rid)
      : null
  res.once('close', () => early?.stop())
  const job = early
    ? {
        ...CHAT_JOB,
        onWait: (ahead: number) => {
          if (ahead > 0) early.status('queued', { ahead })
        }
      }
    : CHAT_JOB
  await modalityQueue.run(job, async () => {
    const requested = requestedModel
    if (!parseRemoteVisionModelId(requested)) {
      const { getCatalog, listInstalled, loadLocalChatModelForRequest, displayModelName } = await import('./models-manager')
      const installed = await listInstalled()
      const catalog = (await getCatalog()).models as { id: string; kind: string; remoteServerId?: string }[]
      const selected = !!requested && catalog.some((model) => model.id === requested && !model.remoteServerId &&
        (model.kind === 'text' || model.kind === 'vision') && installed.includes(model.id))
      if (selected && llm.activeModelInfo()?.id !== requested) {
        early?.status('loading', { model: displayModelName(requested) ?? requested })
        const result = await loadLocalChatModelForRequest(requested)
        if (!result.success) { json(res, 400, errBody(result.error ?? 'Model could not be selected.')); return }
      }
      // A request that names no model takes this Mac's chat model, loaded if it is not yet.
      if ((selected || !requested) && llm.modelsExist()) {
        const active = llm.activeModelInfo()?.id
        if (!llm.isReady() && active) early?.status('loading', { model: displayModelName(active) ?? active })
        await llm.init()
      }
    }
  try {
    let changed = await inlineChatImages(body)
    // Gemma 4 (and others) reject system messages that aren't at position 0.
    // Consolidate them before forwarding so any client's ordering works.
    if (sanitizeChatMessages(body)) changed = true
    // A client says WHETHER it wants thinking; this server decides HOW, because the second half
    // of the answer (reasoning_format) is a property of the model server running here, not of the
    // request. Without this a phone could ask for thinking and get a reply with nothing in it.
    if (applyThinkingPayload(body, llm.currentThinkingDialect)) changed = true
    if (changed) forward = Buffer.from(JSON.stringify(body))
  } catch {
    // Image fetch failed — forward the original valid request unchanged so the
    // model process can return its own stable input error.
  }

  // A paired Mobile sends the stable remote inventory id advertised by Desktop.
  // Route that id through the configured remote server instead of llama-server.
  if (!res.headersSent) res.setHeader('X-Request-Id', rid)
  const activity = new AIRequestHandle({
    modality: 'text',
    source: 'API chat',
    model: typeof body.model === 'string' ? body.model : undefined,
    request: body
  })
  activity.update({ effectiveRequest: body, backend: llm.activeAccelerator() ?? 'Unknown' })
  if (proxyToSelectedRemote(res, body, activity)) return

  // Async chat: run a non-streaming completion in the background and poll for it.
  if (isAsync(req, body)) {
    const inlined = body
    let completion: Promise<unknown> | undefined
    await serve(
      res,
      rid,
      'chat',
      '/v1/chat/completions',
      true,
      () => completion = (async () => {
        try {
          const result = await callLlamaJson(inlined, Date.now() + 45_000)
          activity.finish(result)
          return result
        } catch (error) {
          activity.finish(undefined, error)
          throw error
        }
      })(),
      () => {}
    )
    await completion?.catch(() => {})
    return
  }

  // Sync: stream straight through. Retry for up to 45s if llama-server is mid-reload
  // (e.g. just after an image generation freed and is respawning it, ~16s).
  await new Promise<void>((resolve) => {
    res.once('close', resolve)
    res.once('finish', resolve)
    proxyToLlama(req, res, forward, Date.now() + 45_000, activity, undefined, false, undefined, early)
  })
  }).catch((error) => {
    if (!res.writableEnded && !res.destroyed) {
      const failure = errMeta(error)
      json(res, failure.status, errBody(failure.message, failure.type))
    }
  })
}

// ─── Kept-loaded models ──────────────────────────────────────────────────────

/** A request for a model the gateway keeps loaded goes to the model router, one at a time per
 *  model, with no model swap and no wait behind the chat engine. */
async function handleKeptModelChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rid: string,
  body: Record<string, unknown>,
  buf: Buffer
): Promise<void> {
  const model = body.model as string
  const port = keepLoadedPort()
  let early: EarlyStream | null = null
  const waitingStream = (): EarlyStream | null =>
    body.stream === true && !isAsync(req, body) ? (early ??= openEarlyStream(res, rid)) : null
  res.once('close', () => early?.stop())
  let forward: Buffer = buf
  try {
    await inlineChatImages(body)
    sanitizeChatMessages(body)
  } catch {
    // Image fetch failed — forward the request as it is so the model returns its own error.
  }
  // The router knows the model by its router name.
  forward = Buffer.from(JSON.stringify({ ...body, model: routerModelName(model) }))
  if (!res.headersSent) res.setHeader('X-Request-Id', rid)
  const activity = new AIRequestHandle({
    modality: 'text',
    source: 'API chat',
    model,
    request: body
  })
  activity.update({ effectiveRequest: body, backend: 'Model router' })
  if (port === null) {
    activity.finish(undefined, new Error('The model router is not running.'))
    json(res, 503, errBody('The model router is not running.'))
    return
  }
  if (isAsync(req, body)) {
    await serve(
      res,
      rid,
      'chat',
      '/v1/chat/completions',
      true,
      async () => {
        const release = await keepLoadedLimiter(model).acquire()
        try {
          const result = await callLlamaJson(
            { ...body, model: routerModelName(model) },
            Date.now() + 45_000,
            port,
            true
          )
          activity.finish(result)
          return result
        } catch (error) {
          activity.finish(undefined, error)
          throw error
        } finally {
          release()
        }
      },
      () => {}
    )
    return
  }
  const release = await admitTeamRequest(keepLoadedLimiter(model), res, 0, 'caller', waitingStream)
  if (!release) return
  proxyToLlama(req, res, forward, Date.now() + 45_000, activity, port, true, release, early)
}

// ─── Team-mode chat ──────────────────────────────────────────────────────────

/** The installed local chat models, read at most every ten seconds instead of on every request. */
let chatModelIdsCache: { at: number; ids: Set<string> } | null = null
async function localChatModelIds(): Promise<Set<string>> {
  if (chatModelIdsCache && Date.now() - chatModelIdsCache.at < 10_000) return chatModelIdsCache.ids
  const { getCatalog, listInstalled } = await import('./models-manager')
  const installed = new Set(await listInstalled())
  const catalog = (await getCatalog()).models as { id: string; kind: string; remoteServerId?: string }[]
  const ids = new Set(
    catalog
      .filter(
        (model) =>
          !model.remoteServerId &&
          (model.kind === 'text' || model.kind === 'vision') &&
          installed.has(model.id)
      )
      .map((model) => model.id)
  )
  chatModelIdsCache = { at: Date.now(), ids }
  return ids
}

/** Load or swap the local chat model when this request needs it. Only that goes through the
 *  app-wide queue, with the engine to itself: running streams finish first. Returns an error to
 *  send, or null when the model is ready to take the request. */
async function prepareTeamChatModel(
  requested: string,
  onLoading?: (model: string) => void
): Promise<string | null> {
  const active = llm.activeModelInfo()?.id
  if (llm.isReady() && (!requested || requested === active)) return null
  const selected = !!requested && (await localChatModelIds()).has(requested)
  const swap = selected && requested !== active
  if (!swap && (llm.isReady() || !(selected || llm.modelsExist()))) return null
  let failure: string | null = null
  await modalityQueue.run(CHAT_JOB, () =>
    chatLimiter().exclusive(async () => {
      const { loadLocalChatModelForRequest, displayModelName } = await import('./models-manager')
      const loading = swap ? requested : llm.activeModelInfo()?.id
      if (loading && (swap || !llm.isReady())) onLoading?.(displayModelName(loading) ?? loading)
      if (swap && llm.activeModelInfo()?.id !== requested) {
        const result = await loadLocalChatModelForRequest(requested)
        if (!result.success) {
          failure = result.error ?? 'Model could not be selected.'
          return
        }
      }
      await llm.init()
    })
  )
  return failure
}

/** Whether the loaded chat model is not the installed local model this request named. */
async function onOtherModel(requested: string): Promise<boolean> {
  if (!requested || llm.activeModelInfo()?.id === requested) return false
  return (await localChatModelIds()).has(requested)
}

/**
 * A turn on the chat limiter for the model the request named. Another client's request may swap
 * the model while this one waits in line; then it gives the turn back, loads its model again (the
 * swap waits for the streams in flight) and takes a new turn, so it never gets another model's
 * reply. Null when the request was answered (refused, gone, or its model could not be loaded).
 */
async function admitOnRequestedModel(
  requested: string,
  admit: () => Promise<Release | null>,
  res?: http.ServerResponse
): Promise<Release | null> {
  for (;;) {
    const release = await admit()
    if (!release || !(await onOtherModel(requested))) return release
    release()
    const failure = await prepareTeamChatModel(requested)
    if (failure) {
      if (res && !res.writableEnded) json(res, 400, errBody(failure))
      return null
    }
  }
}

/** GET /v1/gateway/status: the mode, requests at once, and each runtime's line. Team mode reads
 *  the limiters; single mode reads the app's one queue, where chat, images and speech take turns
 *  with the person's own work, and leaves null where single mode sets no limit. */
function gatewayStatus(): Record<string, unknown> {
  const mode = llm.gatewayMode()
  const base = {
    object: 'gateway.status',
    mode,
    requests_at_once: llm.gatewayClients() ?? 'auto',
    slots: llm.gatewaySlots(),
    kept_models: keptModelIds()
  }
  if (mode === 'team') return { ...base, runtimes: teamRuntimeStatus() }
  const queue = modalityQueue.getState()
  const turns = (label: string): Record<string, number> => ({
    capacity: 1,
    running: queue.running.filter((job) => job.label === label).length,
    waiting: queue.queued.filter((job) => job.label === label).length,
    refused: 0
  })
  const open = { capacity: null, running: null, waiting: null, refused: 0 }
  return {
    ...base,
    runtimes: {
      chat: turns('chat'),
      grounder: open,
      decision: open,
      kev: open,
      remote: open,
      image: turns('image'),
      transcription: open,
      speech: turns('speech'),
      embeddings: open
    }
  }
}

/** The client waited too long in line: tell it when to come back. */
function sendLimiterFull(res: http.ServerResponse, error: LimiterFullError): void {
  if (!res.headersSent) res.setHeader('Retry-After', String(error.retryAfterSeconds))
  json(res, 429, errBody(error.message, 'rate_limit_error'))
}

/** Wait for a turn on `limiter`; a client that disconnects while waiting leaves the line. Null when
 *  the request was answered (429, or the client is gone). */
async function admitTeamRequest(
  limiter: UpstreamLimiter,
  res: http.ServerResponse,
  tokens = 0,
  /** 'client': the turn ends when the client's response closes. 'caller': the caller ends it
   *  (proxyToLlama, once llama-server has let go of the request too). */
  holdUntil: 'client' | 'caller' = 'client',
  /** A streaming request that has to wait answers at once (see openEarlyStream); one that runs
   *  at once or is refused keeps its ordinary response. */
  waitingStream?: () => EarlyStream | null
): Promise<Release | null> {
  const gone = new AbortController()
  const onClose = (): void => gone.abort()
  res.once('close', onClose)
  try {
    const release = await limiter.acquire(gone.signal, tokens, (ahead) =>
      waitingStream?.()?.status('queued', ahead > 0 ? { ahead } : {})
    )
    if (res.destroyed) {
      release()
      return null
    }
    if (holdUntil === 'client') res.once('close', release)
    return release
  } catch (error) {
    if (gone.signal.aborted) return null
    if (error instanceof LimiterFullError) sendLimiterFull(res, error)
    else {
      const failure = errMeta(error)
      json(res, failure.status, errBody(failure.message, failure.type))
    }
    return null
  } finally {
    res.off('close', onClose)
  }
}

async function handleTeamChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rid: string,
  body: Record<string, unknown>,
  buf: Buffer
): Promise<void> {
  const requested = typeof body.model === 'string' ? body.model : ''
  const remote = !!requested && !!parseRemoteVisionModelId(requested)
  // A streaming chat for a model here that has to wait answers at once and says what it waits for.
  let early: EarlyStream | null = null
  const waitingStream = (): EarlyStream | null =>
    body.stream === true && !remote && !isAsync(req, body)
      ? (early ??= openEarlyStream(res, rid))
      : null
  res.once('close', () => early?.stop())
  if (!remote) {
    try {
      const failure = await prepareTeamChatModel(requested, (model) =>
        waitingStream()?.status('loading', { model })
      )
      if (failure) {
        json(res, 400, errBody(failure))
        return
      }
    } catch (error) {
      const failure = errMeta(error)
      json(res, failure.status, errBody(failure.message, failure.type))
      return
    }
    teamLimiter('chat')
  }

  let forward: Buffer = buf
  try {
    let changed = await inlineChatImages(body)
    if (sanitizeChatMessages(body)) changed = true
    if (applyThinkingPayload(body, llm.currentThinkingDialect)) changed = true
    if (changed) forward = Buffer.from(JSON.stringify(body))
  } catch {
    // Image fetch failed — forward the original request so the model returns its own error.
  }
  if (!res.headersSent) res.setHeader('X-Request-Id', rid)
  // What this request may take from the shared KV pool: its prompt (images by their token cost,
  // not their encoded size) and its reply cap, which thinking makes longer when none is set.
  const maxTokens = body.max_tokens ?? body.max_completion_tokens
  const prompt = chatPromptShape(body)
  const tokens = chatRequestTokens(
    prompt.chars,
    typeof maxTokens === 'number' ? maxTokens : undefined,
    llm.engineContextWindow(),
    { images: prompt.images, thinking: requestedThinking(body) === true }
  )

  // Async chat answers 202 at once and takes its turn in the background.
  if (!remote && isAsync(req, body)) {
    const activity = new AIRequestHandle({
      modality: 'text',
      source: 'API chat',
      model: requested || undefined,
      request: body
    })
    activity.update({ effectiveRequest: body, backend: llm.activeAccelerator() ?? 'Unknown' })
    await serve(
      res,
      rid,
      'chat',
      '/v1/chat/completions',
      true,
      async () => {
        const release = await admitOnRequestedModel(requested, () =>
          teamLimiter('chat').acquire(undefined, tokens)
        )
        if (!release) throw new Error('Model could not be selected.')
        try {
          const result = await callLlamaJson(body, Date.now() + 45_000, undefined, true)
          activity.finish(result)
          return result
        } catch (error) {
          activity.finish(undefined, error)
          throw error
        } finally {
          release()
        }
      },
      () => {}
    )
    return
  }

  const release = remote
    ? await admitTeamRequest(teamLimiter('remote'), res)
    : await admitOnRequestedModel(
        requested,
        () => admitTeamRequest(teamLimiter('chat'), res, tokens, 'caller', waitingStream),
        res
      )
  if (!release) return
  const activity = new AIRequestHandle({
    modality: 'text',
    source: 'API chat',
    model: requested || undefined,
    request: body
  })
  activity.update({ effectiveRequest: body, backend: llm.activeAccelerator() ?? 'Unknown' })
  if (proxyToSelectedRemote(res, body, activity, true)) return
  proxyToLlama(req, res, forward, Date.now() + 45_000, activity, undefined, true, release, early)
}

/** /v1/completions in team mode: a turn on the local limiter, the chat retry window, pooled. */
async function handleTeamCompletion(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bytes: Buffer,
  body: unknown
): Promise<void> {
  const release = await admitTeamRequest(teamLimiter('chat'), res, 0, 'caller')
  if (!release) return
  const activity = new AIRequestHandle({ modality: 'text', source: 'API completion', request: body })
  activity.update({ backend: llm.activeAccelerator() ?? 'Unknown' })
  proxyToLlama(req, res, bytes, Date.now() + 45_000, activity, undefined, true, release)
}

// ─── Embeddings (local MiniLM) ───────────────────────────────────────────────
// Served by the in-app embedder (DEFAULT_EMBEDDER, all-MiniLM-L6-v2) rather than
// proxied to llama-server, which isn't started with --embeddings. Same path every
// in-app embedding takes (embeddings.embed).
async function handleEmbeddings(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rid: string
): Promise<void> {
  let payload: Record<string, unknown>
  try {
    payload = await readJson(req)
  } catch {
    json(res, 400, errBody('Invalid JSON body.'))
    return
  }
  const raw = payload.input
  const inputs = Array.isArray(raw) ? raw.map(String) : raw != null ? [String(raw)] : []
  if (!inputs.length) {
    json(res, 400, errBody('Field "input" (string or array of strings) is required.'))
    return
  }
  const run = async (): Promise<unknown> => {
    const vectors: number[][] = []
    if (teamMode()) {
      // Team mode: the whole input in one forward pass, ahead of background indexing.
      vectors.push(...(await embedCoalesced(inputs)))
    } else {
      // One forward pass per batch: padding to the longest input stays bounded.
      for (let i = 0; i < inputs.length; i += 32) {
        vectors.push(
          ...(await embeddings.embed(inputs.slice(i, i + 32), { model: DEFAULT_EMBEDDER.model }))
        )
      }
    }
    return {
      object: 'list',
      data: vectors.map((embedding, index) => ({ object: 'embedding', index, embedding })),
      model: DEFAULT_EMBEDDER.model.replace(/^Xenova\//, ''),
      usage: { prompt_tokens: 0, total_tokens: 0 }
    }
  }
  await serve(res, rid, 'embedding', '/v1/embeddings', isAsync(req, payload), run, (result) =>
    jsonWithId(res, rid, result)
  )
}

// ─── Models list (all modalities) ────────────────────────────────────────────
// One ACTIVE model per modality is served on demand: a request loads it, returns,
// then it's offloaded — models never co-reside in RAM (that's why long calls hand
// back a request id to poll). Text, vision and image list every installed model so a
// client can choose one per request; speech and transcription report the active pick.
// llama-server's own /v1/models only knows the loaded text/vision LLM; we fetch
// that and fold in the image, speech (TTS), and transcription (STT) models.
// Each entry carries a non-standard `kind` (chat/vision/image/speech/transcription).
function fetchUpstreamModels(route = '/v1/models'): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const r = http.request(
      { hostname: UPSTREAM_HOST, port: upstreamPort(), path: route, method: 'GET' },
      (pr) => {
        let b = ''
        pr.on('data', (d) => (b += d))
        pr.on('end', () => {
          try {
            resolve(JSON.parse(b))
          } catch {
            resolve({})
          }
        })
      }
    )
    r.on('error', () => resolve({}))
    r.end()
  })
}

async function handleModelsList(
  res: http.ServerResponse,
  outputModalities?: string
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const upstream = await fetchUpstreamModels()
  const upData = Array.isArray(upstream.data) ? (upstream.data as Record<string, unknown>[]) : []
  // Tag the LLM entries chat vs vision from their advertised capabilities.
  let text: Record<string, unknown>[] = tagLlmEntries(upData)
  const activeRemote = getActiveRemoteVisionServer()
  if (activeRemote) {
    const reasoning = await remoteReasoningCapability(activeRemote)
    const supportsReasoning = reasoning.control !== 'none'
    // What the server's own model list says, as Desktop's chat reads it: never assumed.
    const vision = remoteTextVision(
      activeRemote.modelCatalog?.find((model) => model.id === activeRemote.model)
    )
    const tools = (await remoteNativeToolCapability(activeRemote)).status !== 'unsupported'
    text = [
      {
        id: remoteVisionModelId(activeRemote.id, activeRemote.model),
        name:
          activeRemote.modelCatalog?.find((model) => model.id === activeRemote.model)?.name ??
          activeRemote.model,
        object: 'model',
        created: now,
        owned_by: activeRemote.name,
        kind: 'chat',
        remote: true,
        // Mobile must not probe the local llama /props endpoint for capabilities of
        // this remote model, because that reports the wrong active model.
        capabilities: [
          ...(vision ? ['vision'] : []),
          ...(tools ? ['tools'] : []),
          ...(supportsReasoning ? ['reasoning'] : [])
        ],
        ...(supportsReasoning ? { reasoning: { mandatory: reasoning.mandatory === true } } : {})
      }
    ]
  }
  // Fall back to the on-disk active model when the upstream llama-server hasn't
  // loaded one yet (idle app, headless gateway, or a server that came up without
  // a model). Without this, /v1/models reports an empty chat model even though one
  // is installed and would load on the next request.
  if (!activeRemote && text.length === 0) {
    const info = llm.activeModelInfo()
    if (info) {
      text = [
        {
          id: info.id,
          object: 'model',
          created: now,
          owned_by: 'off-grid',
          kind: info.vision ? 'vision' : 'chat'
        }
      ]
    }
  }

  const tag = (
    id: string,
    kind: string,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => modelEntry(id, kind, now, extra)

  // Every installed image model, active pick first. A request names the one it wants and
  // generation loads that file; a remote image server stays the single routed pick.
  const imgId = activeImageModel()
  const remoteImage = getActiveRemoteVisionServerForModality('image')
  const images = remoteImage
    ? [tag(imgId ?? remoteVisionModelId(remoteImage.id, remoteImage.selectedModel), 'image')]
    : installedImageModelEntries(listImageModels(), imgId, now)

  // Active speech (TTS) model + its available voices.
  let voices: string[] = []
  try {
    voices = await tts.listVoices()
  } catch {
    /* TTS may be unavailable */
  }
  const remoteVoice = getActiveRemoteVisionServerForModality('voice')
  const speechId = remoteVoice
    ? remoteVisionModelId(remoteVoice.id, remoteVoice.selectedModel)
    : getActiveModal('speech') || (voices.length ? 'kokoro' : null)
  const speech = speechId
    ? [
        tag(speechId, 'speech', {
          voices,
          supported_voices: voices,
          architecture: { input_modalities: ['text'], output_modalities: ['speech'] },
          ...(remoteVoice ? { remote: true } : {})
        })
      ]
    : []

  // Active transcription (STT) model (chosen pick, else the resolved whisper model).
  const remoteStt = getActiveRemoteVisionServerForModality('transcription')
  const sttId = remoteStt
    ? remoteVisionModelId(remoteStt.id, remoteStt.selectedModel)
    : getActiveModal('transcription') ||
      (whisperModel() ? path.basename(whisperModel() as string) : null)
  const transcription = sttId ? [tag(sttId, 'transcription')] : []

  const video = videoGenerationStatus({ localOnly: true })
  const videos =
    video.available && video.active
      ? [
          tag(video.active, 'video', {
            video_api: 'offgrid-video-v1',
            architecture: { input_modalities: ['text'], output_modalities: ['video'] }
          })
        ]
      : []
  const { desktopCatalog, listInstalled, getCatalog, getActiveModel } = await import('./models-manager')
  const installed = await listInstalled()
  const catalog = (await getCatalog()).models as { id: string; name: string; kind: string; remoteServerId?: string }[]
  if (activeRemote) {
    // This Mac's own models stay listed after the remote one: a request naming one loads it here.
    text = [
      ...text,
      ...installedTextModelEntries(catalog, installed, now).map((entry) => ({
        ...entry,
        context_length: llm.engineContextWindow()
      }))
    ]
  } else {
    const downloaded = installedTextModelEntries(catalog, installed, now)
    if (downloaded.length) text = downloaded
    // Only the model llama-server is serving has known capabilities; the rest stay unknown.
    const loadedId = upData.length ? llm.activeModelInfo()?.id : undefined
    const liveCaps = loadedId ? liveChatCapabilities(await fetchUpstreamModels('/props')) : null
    text = leadWithActiveChatModel(
      text,
      getActiveModel(),
      llm.engineContextWindow(),
      loadedId && liveCaps ? { id: loadedId, capabilities: liveCaps } : null
    )
  }
  // A kept model runs with the window its router plan gave it, not this Mac's engine setting.
  text = text.map((entry) => {
    const kept = typeof entry.id === 'string' ? keepLoadedContextLength(entry.id) : null
    return kept === null ? entry : { ...entry, context_length: kept }
  })
  const specialists = specialistModelEntries(await desktopCatalog(), installed, now)
  const data: Record<string, unknown>[] = [
    ...text,
    ...specialists.filter((model) => !text.some((entry) => entry.id === model.id)),
    ...images,
    ...videos,
    ...speech,
    ...transcription
  ]
  const requested = outputModalities
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const visible =
    requested?.length && !requested.includes('all')
      ? data.filter((entry) =>
          requested.includes(
            entry.kind === 'video' || entry.kind === 'speech' || entry.kind === 'image'
              ? entry.kind
              : 'text'
          )
        )
      : data
  // Mirror into the ollama-style `models` array some clients read, so both shapes
  // stay in sync.
  const models = ollamaMirror(visible)
  json(res, 200, { object: 'list', data: visible, models })
}

// ─── Speech-to-text (whisper) ────────────────────────────────────────────────
async function handleTranscription(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rid: string
): Promise<void> {
  const ct = req.headers['content-type'] || ''
  if (!ct.includes('multipart/form-data')) {
    json(res, 400, errBody('Send multipart/form-data with a "file" field.'))
    return
  }
  let body: Buffer
  try {
    body = await readBody(req, MAX_UPLOAD)
  } catch {
    json(res, 413, errBody('Audio too large.'))
    return
  }
  const { files, fields } = parseMultipart(body, ct)
  const file = files.file || Object.values(files)[0]
  if (!file || !file.data.length) {
    json(res, 400, errBody('No audio file in "file" field.'))
    return
  }
  const ext = path.extname(file.filename) || '.audio'
  const tmp = path.join(os.tmpdir(), `offgrid-stt-${process.pid}-${rid}${ext}`)
  let transcriptionOptions: ReturnType<typeof transcriptionRequestOptions>
  try {
    transcriptionOptions = transcriptionRequestOptions(fields)
  } catch (error) {
    json(
      res,
      400,
      errBody(error instanceof Error ? error.message : 'Invalid transcription options')
    )
    return
  }
  await selectRequestedModal('transcription', fields.model)
  const run = async (signal?: AbortSignal): Promise<unknown> => {
    try {
      await fs.promises.writeFile(tmp, file.data)
      // Team mode: the client leaving (signal) stops the transcription.
      const options = signal ? { ...transcriptionOptions, signal } : transcriptionOptions
      // Team mode: a resident whisper-server lane (model already loaded) when Whisper is active.
      const onLane = teamMode()
        ? await (
            await import('./transcription/team-lanes')
          ).transcribeOnTeamLane({ path: tmp }, options, teamConcurrency().transcription)
        : null
      const text = (
        onLane ?? (await getActiveTranscription().transcribe({ path: tmp }, options))
      ).text.trim()
      return { text }
    } finally {
      fs.promises.unlink(tmp).catch(() => {})
    }
  }
  const wantsText = (fields.response_format || '').toLowerCase() === 'text'
  await serve(
    res,
    rid,
    'transcription',
    '/v1/audio/transcriptions',
    isAsync(req, undefined, fields),
    run,
    (result) => {
      if (wantsText) {
        res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Request-Id': rid })
        res.end((result as { text: string }).text)
      } else {
        jsonWithId(res, rid, result)
      }
    }
  )
}

// ─── Per-request model choice for media modalities ──────────────────────────
/** A request naming an installed image, voice or transcription model makes it that modality's
 *  local model, as a chat request naming an installed model does for Text. */
async function selectRequestedModal(
  modality: 'image' | 'speech' | 'transcription',
  requested: unknown
): Promise<void> {
  if (typeof requested !== 'string' || !requested || parseRemoteVisionModelId(requested)) return
  // A modality the person put on a remote server stays there: a request moves only a local pick.
  // Switching it is /v1/models/activate, an explicit choice.
  if (getActiveRemoteVisionServerForModality(modality === 'speech' ? 'voice' : modality)) return
  const manager = await import('./models-manager')
  if (modality === 'image') {
    if (!listImageModels().includes(requested) || activeImageModel() === requested) return
  } else {
    if (getActiveModal(modality) === requested) return
    const catalog = (await manager.getCatalog()).models as { id: string; kind: string }[]
    const entry = catalog.find((model) => model.id === requested)
    if (!entry || modalityForKind(entry.kind) !== modality) return
    if (!(await manager.listInstalled()).includes(requested)) return
  }
  await manager.setActiveModalChoice(modality, requested)
}

// ─── Text-to-speech (Kokoro) ─────────────────────────────────────────────────
async function handleSpeech(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rid: string
): Promise<void> {
  let payload: Record<string, unknown>
  try {
    payload = await readJson(req)
  } catch {
    json(res, 400, errBody('Invalid JSON body.'))
    return
  }
  const input = String(payload.input ?? payload.text ?? '').trim()
  if (!input) {
    json(res, 400, errBody('Field "input" (text to speak) is required.'))
    return
  }
  await selectRequestedModal('speech', payload.model)
  const voice = typeof payload.voice === 'string' ? payload.voice : undefined
  const fmt = String(payload.response_format ?? '').toLowerCase()
  const run = async (signal?: AbortSignal): Promise<unknown> => {
    // Team mode: several voices at once, one Kokoro worker each (the speech limiter bounds them);
    // the client leaving (signal) stops before the next sentence.
    const { dataUrl } = teamMode()
      ? await tts.synthesize(input, voice, undefined, {
          parallel: { workers: teamConcurrency().speech },
          signal
        })
      : await tts.synthesize(input, voice)
    return { audio: dataUrl, format: 'wav' }
  }
  // Team mode, `stream: true`: audio goes out sentence by sentence, so the first sound arrives
  // after one sentence instead of after the whole reply.
  if (teamMode() && payload.stream === true && !isAsync(req, payload)) {
    await streamTeamSpeech(res, rid, input, voice)
    return
  }
  // OpenAI's /v1/audio/speech returns raw audio bytes; honor a JSON-ish
  // response_format with a data URL. (Async results are always the JSON form.)
  await serve(res, rid, 'speech', '/v1/audio/speech', isAsync(req, payload), run, (result) => {
    const dataUrl = (result as { audio: string }).audio
    if (fmt === 'json' || fmt === 'b64_json') {
      jsonWithId(res, rid, result)
    } else {
      const wav = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
      res.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': String(wav.length),
        'X-Request-Id': rid
      })
      res.end(wav)
    }
  })
}

/** Team-mode streamed speech: a WAV whose first chunk is the first sentence (see
 *  streamingWavChunk). A failure before any audio is a JSON error; after it, the stream is cut. */
async function streamTeamSpeech(
  res: http.ServerResponse,
  rid: string,
  input: string,
  voice: string | undefined
): Promise<void> {
  const { streamingWavChunk } = await import('@offgrid/speech')
  // An object, so the check after the await sees what the pass callbacks set.
  const stream = { started: false }
  const send = (dataUrl: string): void => {
    if (res.destroyed) return
    const wav = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    const chunk = streamingWavChunk(wav, !stream.started)
    if (!chunk) return
    if (!stream.started) {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'X-Request-Id': rid })
      res.flushHeaders()
      res.socket?.setNoDelay(true)
      stream.started = true
    }
    res.write(chunk)
  }
  // The client leaving stops the voice before its next sentence, freeing the worker.
  const gone = new AbortController()
  const leave = (): void => {
    if (!res.writableEnded) gone.abort(new Error('The client disconnected.'))
  }
  res.once('close', leave)
  try {
    const { dataUrl } = await onTeamTurn('speech', res, false, () =>
      tts.synthesize(input, voice, undefined, {
        parallel: { workers: teamConcurrency().speech },
        onPass: (pass) => send(pass.dataUrl),
        signal: gone.signal
      })
    )()
    // A reply of one sentence has no separate passes: send it whole.
    if (!stream.started) send(dataUrl)
    res.end()
  } catch (error) {
    if (!stream.started && !res.destroyed) {
      const failure = errMeta(error)
      json(res, failure.status, errBody(failure.message, failure.type))
    } else res.destroy()
  } finally {
    res.off('close', leave)
  }
}

// ─── Text-to-image / image-to-image (diffusion) ──────────────────────────────
// Run the diffusion model and return the canonical image result. Throws with a
// .status so failures map to the right HTTP code (501 when no model installed).
// `cleanup` removes any temp init image once the work is done (sync or async).
async function executeImage(
  params: ImageGenParams,
  responseFormat: string,
  cleanup?: () => void,
  onProgress?: (progress: { step: number; total: number }) => void,
  signal?: AbortSignal
): Promise<unknown> {
  try {
    const status = imageGenStatus()
    if (!status.available) {
      const err = new Error(`Image generation unavailable: ${status.reason}.`) as Error & {
        status?: number
      }
      err.status = 501
      throw err
    }
    const out = await generateImage(
      params,
      (update) => {
        if (update.stage === 'generating' && update.progress) {
          onProgress?.({ step: update.progress.step, total: update.progress.total })
        }
      },
      signal
    )
    const b64 = out.dataUrl.slice(out.dataUrl.indexOf(',') + 1)
    const datum =
      responseFormat === 'url'
        ? {
            url: `file://${out.path}`,
            revised_prompt: out.prompt,
            seed: out.seed,
            model: out.model
          }
        : { b64_json: b64, revised_prompt: out.prompt, seed: out.seed, model: out.model }
    return {
      created: Math.floor(Date.now() / 1000),
      data: [datum],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    }
  } finally {
    cleanup?.()
  }
}

async function handleImageGeneration(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rid: string
): Promise<void> {
  let payload: Record<string, unknown>
  try {
    payload = await readJson(req)
  } catch {
    json(res, 400, errBody('Invalid JSON body.'))
    return
  }
  const prompt = String(payload.prompt ?? '').trim()
  if (!prompt) {
    json(res, 400, errBody('Field "prompt" is required.'))
    return
  }
  const { width, height } = resolveDims(payload)
  const params: ImageGenParams = {
    prompt,
    negativePrompt:
      typeof payload.negative_prompt === 'string' ? payload.negative_prompt : undefined,
    width,
    height,
    steps: typeof payload.steps === 'number' ? payload.steps : undefined,
    seed: typeof payload.seed === 'number' ? payload.seed : undefined,
    cfgScale: typeof payload.cfg_scale === 'number' ? payload.cfg_scale : undefined,
    model: typeof payload.model === 'string' ? payload.model : undefined,
    allowUnsafeMemoryOverride: payload.allow_unsafe_memory_override === true
  }
  const fmt = String(payload.response_format ?? 'b64_json')
  await selectRequestedModal('image', params.model)
  await serve(
    res,
    rid,
    'image',
    '/v1/images/generations',
    isAsync(req, payload),
    (signal) =>
      executeImage(
        params,
        fmt,
        undefined,
        (progress) => {
          const request = requests.get(rid)
          if (request) {
            request.progress = progress
            request.updated_at = Date.now()
          }
        },
        signal
      ),
    (r) => jsonWithId(res, rid, r)
  )
}

// OpenRouter-style unified image endpoint: text-to-image, and image-to-image via
// `input_references` (data URLs, http(s) URLs, or local paths) — all over JSON,
// no multipart needed.  POST /v1/images
async function handleImagesUnified(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rid: string
): Promise<void> {
  let payload: Record<string, unknown>
  try {
    payload = await readJson(req)
  } catch {
    json(res, 400, errBody('Invalid JSON body.'))
    return
  }
  const prompt = String(payload.prompt ?? '').trim()
  if (!prompt) {
    json(res, 400, errBody('Field "prompt" is required.'))
    return
  }
  const { width, height } = resolveDims(payload)
  const params: ImageGenParams = {
    prompt,
    negativePrompt:
      typeof payload.negative_prompt === 'string' ? payload.negative_prompt : undefined,
    width,
    height,
    steps: typeof payload.steps === 'number' ? payload.steps : undefined,
    seed: typeof payload.seed === 'number' ? payload.seed : undefined,
    cfgScale: typeof payload.cfg_scale === 'number' ? payload.cfg_scale : undefined,
    model: typeof payload.model === 'string' ? payload.model : undefined,
    strength: typeof payload.strength === 'number' ? payload.strength : undefined,
    allowUnsafeMemoryOverride: payload.allow_unsafe_memory_override === true
  }

  // image-to-image: first input_reference becomes the init image.
  let tmp: string | null = null
  const refs = payload.input_references
  const firstRef = Array.isArray(refs) ? refs[0] : undefined
  const refUrl =
    typeof firstRef === 'string'
      ? firstRef
      : (firstRef as { image_url?: { url?: string } } | undefined)?.image_url?.url
  try {
    if (refUrl) {
      const { data, mime } = await fetchImage(refUrl)
      const ext = extForMime(mime)
      // Named by the request: two references of the same size must not share a file.
      tmp = path.join(os.tmpdir(), `offgrid-imgref-${process.pid}-${rid}${ext}`)
      await fs.promises.writeFile(tmp, data)
      params.initImage = tmp
    }
  } catch (e) {
    json(
      res,
      500,
      errBody(e instanceof Error ? e.message : 'failed to load input_reference', 'server_error')
    )
    return
  }
  const cleanup = (): void => {
    if (tmp) fs.promises.unlink(tmp).catch(() => {})
  }
  const fmt = String(payload.response_format ?? 'b64_json')
  await selectRequestedModal('image', params.model)
  await serve(
    res,
    rid,
    'image',
    '/v1/images',
    isAsync(req, payload),
    (signal) => executeImage(params, fmt, cleanup, undefined, signal),
    (r) => jsonWithId(res, rid, r)
  )
}

async function handleImageEdit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  rid: string
): Promise<void> {
  const ct = req.headers['content-type'] || ''
  if (!ct.includes('multipart/form-data')) {
    json(res, 400, errBody('Send multipart/form-data with an "image" file and a "prompt" field.'))
    return
  }
  let body: Buffer
  try {
    body = await readBody(req, MAX_UPLOAD)
  } catch {
    json(res, 413, errBody('Image too large.'))
    return
  }
  const { files, fields } = parseMultipart(body, ct)
  const image = files.image || Object.values(files)[0]
  if (!image || !image.data.length) {
    json(res, 400, errBody('No init image in "image" field.'))
    return
  }
  const prompt = (fields.prompt || '').trim()
  if (!prompt) {
    json(res, 400, errBody('Field "prompt" is required.'))
    return
  }
  const ext = path.extname(image.filename) || '.png'
  // Named by the request: two uploads of the same size must not share a file.
  const tmp = path.join(os.tmpdir(), `offgrid-img2img-${process.pid}-${rid}${ext}`)
  await fs.promises.writeFile(tmp, image.data)
  const { width, height } = resolveDims({
    width: fields.width ? parseInt(fields.width, 10) : undefined,
    height: fields.height ? parseInt(fields.height, 10) : undefined,
    size: fields.size,
    aspect_ratio: fields.aspect_ratio,
    resolution: fields.resolution
  })
  const params: ImageGenParams = {
    prompt,
    initImage: tmp,
    strength: fields.strength ? parseFloat(fields.strength) : undefined,
    negativePrompt: fields.negative_prompt || undefined,
    width,
    height,
    steps: fields.steps ? parseInt(fields.steps, 10) : undefined,
    seed: fields.seed ? parseInt(fields.seed, 10) : undefined,
    cfgScale: fields.cfg_scale ? parseFloat(fields.cfg_scale) : undefined,
    model: fields.model || undefined,
    allowUnsafeMemoryOverride: fields.allow_unsafe_memory_override === 'true'
  }
  const cleanup = (): void => {
    fs.promises.unlink(tmp).catch(() => {})
  }
  const fmt = String(fields.response_format ?? 'b64_json')
  await selectRequestedModal('image', params.model)
  await serve(
    res,
    rid,
    'image',
    '/v1/images/edits',
    isAsync(req, undefined, fields),
    (signal) => executeImage(params, fmt, cleanup, undefined, signal),
    (r) => jsonWithId(res, rid, r)
  )
}

// ─── Server ──────────────────────────────────────────────────────────────────
/** Origins trusted with protected gateway routes: the packaged renderer, the gateway's own
 *  loopback pages and, in development, electron-vite's loopback renderer. */
function trustedGatewayOrigins(port: number): string[] {
  const loopback = ['localhost', '127.0.0.1', '[::1]']
  const origins = ['file://', ...loopback.map((host) => `http://${host}:${port}`)]
  const renderer = process.env['ELECTRON_RENDERER_URL']
  if (renderer) {
    try {
      const dev = new URL(renderer)
      if (dev.protocol === 'http:' && loopback.includes(dev.hostname)) origins.push(dev.origin)
    } catch {
      // A malformed dev renderer URL adds no trusted origin.
    }
  }
  return origins
}

/** The port the gateway actually bound. Falls back off GATEWAY_PORT when it's taken (a 2nd Off Grid AI Desktop
 *  instance); consumers (setup health ping, the Gateway UI) must read this LIVE value. */
let boundGatewayPort = GATEWAY_PORT
export function getGatewayPort(): number {
  return boundGatewayPort
}
let startingGateway = false

/** A request from this machine. The gateway listens on every interface (phones reach the models),
 *  so a route that changes settings checks this itself: nothing else stands in front of it. */
function isLocalCaller(req: http.IncomingMessage): boolean {
  const remote = req.socket.remoteAddress
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

/** Routes a website must never reach: tool and file access over /mcp, search, settings writes, and model
 *  management writes (download, cancel, activate, delete, task roles). The OpenAI-compatible
 *  inference routes stay open to any origin, as in 0.0.54, so tools that call the gateway from a
 *  browser or an Electron app keep working. A preflight is judged by the method it asks for. */
export function protectedGatewayRoute(
  method: string | undefined,
  url: string | undefined,
  requestedMethod?: string | string[]
): boolean {
  const effective = (
    method === 'OPTIONS' && typeof requestedMethod === 'string'
      ? requestedMethod
      : (method ?? 'GET')
  ).toUpperCase()
  const pathname = new URL(url ?? '/', 'http://localhost').pathname
  if (pathname === '/mcp' || pathname.startsWith('/mcp/')) return true
  // Search reads everything this computer has seen; only the paired apps may ask.
  if (pathname === '/v1/search') return true
  if (pathname === '/v1/settings') return effective !== 'GET'
  if (pathname === '/v1/models' || pathname.startsWith('/v1/models/')) return effective !== 'GET'
  return false
}

/** Start the unified local model gateway. Bound to loopback (local-only). Async because it scans
 *  for a free port when the preferred one is taken. */
export async function startModelServer(port = GATEWAY_PORT): Promise<void> {
  if (server || startingGateway) return
  startingGateway = true
  try {
    const availablePort = await pickFreePort(port, (candidate) =>
      isPortFree(candidate, GATEWAY_BIND_HOST)
    )
    if (availablePort === null) throw new Error(`No free gateway port on ${GATEWAY_BIND_HOST}.`)
    boundGatewayPort = availablePort
  } catch (error) {
    startingGateway = false
    throw error
  }

  // An eviction of the chat model (an image job needs its memory) waits for team-mode streams to
  // finish and admits no new ones meanwhile. In single mode no stream holds the limiter.
  llm.setEvictionGate((evict) => chatLimiter().exclusive(evict))
  // A relaunch for changed settings (the mode, the context, the cache type...) lets team-mode
  // streams in flight finish first, for at most a minute.
  llm.setRelaunchGate((relaunch) => chatLimiter().exclusive(relaunch, TEAM_DRAIN_TIMEOUT_MS))
  // The Decider's llama-server opens slots in team mode too; it reads the mode from here.
  void import('./accessibility/decision-runtime').then(({ setDecisionGatewayModeSource }) =>
    setDecisionGatewayModeSource(() => llm.gatewayMode())
  )

  // The models the person keeps loaded start with the gateway, in their own router.
  void applyKeepLoaded().catch((error) => console.error('[keep-loaded] start failed:', error))

  // Each request runs in its own scope, so the records it starts can name its API key.
  server = http.createServer((req, res) => void withGatewayRequestScope(async () => {
    const origin = req.headers.origin
    if (origin !== undefined) {
      // Packaged renderers use file://; dev uses electron-vite. Other origins, including the
      // opaque 'null' a sandboxed frame on any website sends, get the inference routes only.
      const trustedOrigins = trustedGatewayOrigins(boundGatewayPort)
      const trustedIndex = trustedOrigins.indexOf(origin)
      const trusted = trustedIndex >= 0
      if (
        !trusted &&
        protectedGatewayRoute(req.method, req.url, req.headers['access-control-request-method'])
      ) {
        json(res, 403, errBody('Origin is not allowed.', 'forbidden'))
        return
      }
      // Trusted origins get their own origin back; any other origin gets the wildcard 0.0.54 sent,
      // which opens the inference routes without reflecting an arbitrary origin.
      res.setHeader('Access-Control-Allow-Origin', trusted ? trustedOrigins[trustedIndex]! : '*')
      res.setHeader('Vary', 'Origin')
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }
    res.setHeader('Access-Control-Allow-Headers', '*, Authorization')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = (req.url || '/').split('?')[0]! // split() always yields >= 1 element
    const method = req.method || 'GET'

    // Check before reading bodies, starting work, serving results, or forwarding aliases.
    // MCP and paired extension traffic use their existing, separate credentials.
    const publicRoute =
      ['/', '/health', '/docs', '/openapi.json', '/mcp'].includes(url) ||
      url.startsWith('/v1/extension/')
    if (!publicRoute) {
      try {
        if (!authorizeGateway(req)) {
          res.setHeader('WWW-Authenticate', 'Bearer realm="Off Grid AI API"')
          json(res, 401, errBody('A valid API key is required.', 'authentication_error'))
          return
        }
      } catch (error) {
        const locked = error instanceof Error && error.message === GATEWAY_KEYS_LOCKED
        json(
          res,
          503,
          errBody(
            locked ? 'API key storage is locked.' : 'API key storage is unavailable.',
            'server_error'
          )
        )
        return
      }
    }

    // Every request gets a stable id — returned as X-Request-Id and reused as the
    // poll id for async work, so any request can be tracked/polled by the same id.
    const rid = randomUUID()
    res.setHeader('X-Request-Id', rid)
    const requestStarted = Date.now()
    writeDiagnosticLog('gateway', 'request.started', { requestId: rid, method, path: url })
    res.once('finish', () => {
      writeDiagnosticLog(
        'gateway',
        'request.completed',
        {
          requestId: rid,
          method,
          path: url,
          status: res.statusCode,
          durationMs: Date.now() - requestStarted
        },
        res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'
      )
    })
    res.once('close', () => {
      if (res.writableEnded) return
      writeDiagnosticLog(
        'gateway',
        'request.disconnected',
        { requestId: rid, method, path: url, durationMs: Date.now() - requestStarted },
        'warn'
      )
    })

    if (
      await dispatchGatewayRoute({
        req,
        res,
        url,
        method,
        rid,
        readJson: () => readJson(req),
        json: (status, body) => json(res, status, body)
      })
    )
      return
    const proFeature = proGatewayFeature(url)
    if (proFeature) {
      json(res, 402, errBody(`${proFeature} needs Off Grid AI Pro.`, 'pro_required'))
      return
    }

    // RESTful polling: GET the request resource. Canonical /v1/requests/{id}, or
    // the per-collection resource (e.g. /v1/images/{id}, /v1/audio/speech/{id}).
    if (method === 'GET') {
      const { id, isPollCollection } = matchPollRoute(url)
      if (url.startsWith('/v1/requests/') && id) return handlePoll(res, id)
      if (id && isPollCollection && requests.has(id)) return handlePoll(res, id)
    }
    if (method === 'DELETE' && url.startsWith('/v1/requests/')) {
      const { prefix, id } = matchPollRoute(url)
      if (prefix === '/v1/requests' && id) return handleCancel(res, id)
    }

    if (url === '/' || url === '/health') {
      const img = imageGenStatus()
      const modalities = await liveGatewayModalities(img.available)
      json(res, 200, {
        name: 'Off Grid AI — local model gateway',
        openai_compatible: true,
        base_url: `http://${GATEWAY_HOST}:${boundGatewayPort}/v1`,
        docs: `http://${GATEWAY_HOST}:${boundGatewayPort}/docs`,
        mcp: `http://${GATEWAY_HOST}:${boundGatewayPort}/mcp`,
        modalities,
        video_api: 'offgrid-video-v1',
        video_models: videoGenerationStatus({ localOnly: true }).models,
        image_models: img.models,
        image_reason: img.available ? undefined : img.reason
      })
      return
    }

    // The browser extension's private, paired, end-to-end sealed link (extension-bridge/).
    if (url.startsWith('/v1/extension/')) return void handleExtensionBridge(req, res, url, method)

    if (url === '/openapi.json') {
      const img = imageGenStatus()
      const modalities = await liveGatewayModalities(img.available)
      json(res, 200, openApiSpec(boundGatewayPort, modalities, img.models))
      return
    }

    if (url === '/docs') {
      // Browsers get the interactive Scalar playground; curl/SDKs get plain text.
      const wantsHtml = (req.headers.accept || '').includes('text/html')
      if (wantsHtml) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(docsHtml(boundGatewayPort))
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(docsText(boundGatewayPort))
      }
      return
    }

    // The bare base URL (no resource) — friendly pointer instead of a confusing
    // 404 from llama-server (which is what hitting GET /v1 directly would give).
    if (url === '/v1' || url === '/v1/') {
      json(res, 200, {
        message: 'Off Grid AI local gateway. OpenAI-compatible API.',
        endpoints: [
          'POST /v1/chat/completions',
          'POST /v1/embeddings',
          'GET  /v1/models',
          'POST /v1/audio/transcriptions',
          'POST /v1/audio/speech',
          'GET  /v1/audio/voices',
          'POST /v1/images',
          'POST /v1/images/generations',
          'POST /v1/images/edits',
          'POST /v1/videos',
          'GET /v1/videos/:id',
          'GET /v1/videos/:id/content',
          'POST /v1/videos/:id/cancel',
          'POST /v1/stories',
          'GET /v1/stories/:id',
          'GET /v1/stories/:id/content',
          'POST /v1/stories/:id/cancel'
        ],
        docs: `http://${GATEWAY_HOST}:${boundGatewayPort}/docs`
      })
      return
    }

    // MCP server — on-device models as MCP tools (Streamable HTTP, stateless).
    // POST carries JSON-RPC; the SDK transport needs the parsed body.
    if (url === '/mcp') {
      if (method === 'POST') {
        void readBody(req, MAX_UPLOAD)
          .then((buf) => {
            let parsed: unknown = undefined
            try {
              parsed = buf.length ? JSON.parse(buf.toString('utf8')) : undefined
            } catch {
              /* let the transport reject malformed JSON */
            }
            return handleMcpRequest(req, res, parsed)
          })
          .catch((e) =>
            json(res, 500, errBody(e instanceof Error ? e.message : 'mcp error', 'server_error'))
          )
        return
      }
      // GET/DELETE in stateless mode have no session to attach to.
      json(
        res,
        405,
        errBody('MCP endpoint accepts POST (stateless Streamable HTTP).', 'method_not_allowed')
      )
      return
    }

    if (url === '/v1/requests' && method === 'GET') {
      json(res, 200, {
        object: 'list',
        data: [...requests.values()].map((r) => ({
          request_id: r.id,
          kind: r.kind,
          status: r.status,
          poll_url: `${r.collection}/${r.id}`
        }))
      })
      return
    }

    // Runtime LLM settings (ctx size, KV-cache, flash-attn, GPU layers, threads,
    // batch, sampling) — read + update remotely so a control plane (the console,
    // via the gateway) can configure this node. setSettings persists and respawns
    // llama-server when launch-time args change.
    if (url === '/v1/settings' && method === 'GET') return json(res, 200, llm.getSettings())
    if (url === '/v1/settings' && method === 'POST') {
      // Mutating launch-time LLM args triggers a llama-server respawn. The listener is
      // on every interface so a phone can reach the models, which makes this check the
      // ONLY thing standing between the LAN and a respawn - not defense in depth.
      if (!isLocalCaller(req)) {
        json(res, 403, errBody('Settings mutations are restricted to localhost.', 'forbidden'))
        return
      }
      return void (async () => {
        const patch = (await readJson(req)) as LlmSettings
        await llm.setSettings(patch)
        json(res, 200, { success: true, settings: llm.getSettings() })
      })().catch((e) =>
        json(res, 500, {
          error: { message: e instanceof Error ? e.message : 'The settings could not be saved.' }
        })
      )
    }

    if (url === '/v1/embeddings' && method === 'POST') return void handleEmbeddings(req, res, rid)
    if (url === '/v1/audio/transcriptions' && method === 'POST')
      return void handleTranscription(req, res, rid)
    if (url === '/v1/audio/speech' && method === 'POST') return void handleSpeech(req, res, rid)
    if (url === '/v1/audio/voices' && method === 'GET') {
      void tts
        .listVoices()
        .then((voices) => json(res, 200, { voices }))
        .catch((e) =>
          json(
            res,
            500,
            errBody(e instanceof Error ? e.message : 'failed to list voices', 'server_error')
          )
        )
      return
    }
    if (url === '/v1/images' && method === 'POST') return void handleImagesUnified(req, res, rid)
    if (url === '/v1/images/generations' && method === 'POST')
      return void handleImageGeneration(req, res, rid)
    if (url === '/v1/images/edits' && method === 'POST') return void handleImageEdit(req, res, rid)

    // --- Model management (pull / delete / activate / list) — the full headless
    // repertoire, so the gateway is self-sufficient without the desktop UI. ---
    if (url.startsWith('/v1/models/') || (url === '/v1/models' && method !== 'GET')) {
      void (async () => {
        try {
          const mm = await import('./models-manager')
          if (url === '/v1/models/catalog' && method === 'GET')
            return json(res, 200, await mm.getCatalog())
          if (url === '/v1/models/installed' && method === 'GET')
            return json(res, 200, { installed: await mm.listInstalled() })
          if (url === '/v1/models/active' && method === 'GET')
            return json(res, 200, mm.getActiveModalities())
          // Every model this desktop counts active, as catalog ids (the Models screen's own
          // answer): a kind can hold more than one, as Computer Use's specialist and decider do.
          if (url === '/v1/models/active-ids' && method === 'GET')
            return json(res, 200, { ids: await mm.getActiveModelIds() })
          // The task models' lineups and roles, as the desktop's Models screen shows them, and the
          // one way to give a model a role. Additive: no existing route changes.
          if (url === '/v1/models/task-roles' && method === 'GET') {
            const { getTaskRolesView } = await import('./vision/vision-task-model-strategy')
            return json(res, 200, await getTaskRolesView())
          }
          if (url === '/v1/models/task-role' && method === 'POST') {
            // A persistent settings change, on a gateway every interface can reach: this machine
            // only, as /v1/settings. A paired browser changes roles over its sealed link instead.
            if (!isLocalCaller(req)) {
              return json(
                res,
                403,
                errBody('Task role changes are restricted to localhost.', 'forbidden')
              )
            }
            const { setTaskRoleFromRequest } = await import('./task-role-requests')
            const result = await setTaskRoleFromRequest(
              (await readJson(req)) as Record<string, unknown>
            )
            return json(res, result.success ? 200 : 400, result)
          }
          if (url === '/v1/models/pull/status' && method === 'GET') {
            const id = (req.url || '').split('?')[1]?.match(/(?:^|&)id=([^&]+)/)?.[1]
            return json(
              res,
              200,
              mm.downloadStatus(decodeURIComponent(id || '')) ?? { status: 'idle' }
            )
          }
          if (url === '/v1/models/pull' && method === 'POST') {
            const { id, fileName } = await readJson(req)
            if (!id) return json(res, 400, { error: 'id required' })
            if (fileName !== undefined && (typeof fileName !== 'string' || !fileName.trim()))
              return json(res, 400, { error: 'fileName must be a non-empty string' })
            // The model manager resolves the selected weights and their companion files.
            // Kick off async; clients poll /v1/models/pull/status?id=.
            void mm.downloadModel(String(id), undefined, fileName)
            return json(res, 202, {
              status: 'started',
              id,
              poll: `/v1/models/pull/status?id=${encodeURIComponent(String(id))}`
            })
          }
          if (url === '/v1/models/cancel' && method === 'POST') {
            const { id } = await readJson(req)
            return json(res, 200, { cancelled: mm.cancelDownload(String(id)) })
          }
          if (url === '/v1/models/activate' && method === 'POST') {
            const { id, kind } = await readJson(req)
            if (!id) return json(res, 400, { error: 'id required' })
            const modelId = String(id)
            const { activateModelFromRequest } = await import('./model-activation-request')
            const r = await activateModelFromRequest(
              modelId,
              typeof kind === 'string' ? kind : undefined
            )
            return json(res, r.success ? 200 : 400, r)
          }
          // DELETE /v1/models/{id}  (or POST /v1/models/delete {id})
          if (method === 'DELETE' && url.startsWith('/v1/models/') && url !== '/v1/models/') {
            const id = decodeURIComponent(url.slice('/v1/models/'.length))
            return json(res, 200, await mm.deleteModel(id))
          }
          if (url === '/v1/models/delete' && method === 'POST') {
            const { id } = await readJson(req)
            if (!id) return json(res, 400, { error: 'id required' })
            return json(res, 200, await mm.deleteModel(String(id)))
          }
          return json(res, 404, { error: 'unknown model endpoint' })
        } catch (e) {
          json(res, 500, { error: (e as Error).message })
        }
      })()
      return
    }

    // Chat (text + image-to-text): buffer so we can inline remote image URLs,
    // which llama-server can't fetch itself, then forward (response still streams).
    if (url === '/v1/chat/completions' && method === 'POST') return void handleChat(req, res, rid)
    if (url === '/v1/gateway/status' && method === 'GET') return json(res, 200, gatewayStatus())
    // Full local model surface across all modalities (not just the LLM).
    if (url === '/v1/models' && method === 'GET')
      return void handleModelsList(
        res,
        new URLSearchParams(req.url?.split('?')[1]).get('output_modalities') ?? undefined
      )

    // Raw completion clients bypass handleChat, but still belong in local AI history.
    if (url === '/v1/completions' && method === 'POST') {
      void (async () => {
        try {
          const bytes = await readBody(req, MAX_UPLOAD)
          const body: unknown = JSON.parse(bytes.toString('utf8'))
          if (teamMode()) return void (await handleTeamCompletion(req, res, bytes, body))
          const activity = new AIRequestHandle({
            modality: 'text',
            source: 'API completion',
            request: body
          })
          activity.update({ backend: llm.activeAccelerator() ?? 'Unknown' })
          proxyToLlama(req, res, bytes, 0, activity)
        } catch {
          json(res, 400, errBody('Invalid or oversized completion request.'))
        }
      })()
      return
    }
    // A kept model's /props (its chat template, so a client knows its thinking controls) comes
    // from the router that serves it; without this a client asking about it gets the local
    // llama-server's 502 and drops thinking and its budget.
    if (url === '/props' && method === 'GET') {
      const model = new URLSearchParams(req.url?.split('?')[1]).get('model')
      const port = keepLoadedPort()
      if (model && port !== null && keepLoadedServes(model)) {
        req.url = `/props?model=${encodeURIComponent(routerModelName(model))}`
        return proxyToLlama(req, res, undefined, 0, undefined, port)
      }
    }
    // Rendering a kept model's prompt (a client checking how its template opens thinking) goes to
    // the router too; the model is named in the body.
    if (url === '/apply-template' && method === 'POST') {
      void (async () => {
        let bytes: Buffer
        try {
          bytes = await readBody(req, MAX_UPLOAD)
        } catch {
          return json(res, 413, errBody('Request too large.'))
        }
        let model: unknown
        try {
          model = (JSON.parse(bytes.toString('utf8')) as { model?: unknown }).model
        } catch {
          model = undefined
        }
        const port = keepLoadedPort()
        if (typeof model === 'string' && port !== null && keepLoadedServes(model)) {
          const named = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
          const routed = Buffer.from(JSON.stringify({ ...named, model: routerModelName(model) }))
          return proxyToLlama(req, res, routed, 0, undefined, port)
        }
        proxyToLlama(req, res, bytes)
      })()
      return
    }
    // Non-inference routes pass through without generating activity rows.
    proxyToLlama(req, res)
  }))

  // Long-running modalities (first-run model downloads, multi-step diffusion,
  // streamed chat) must not be severed by idle/header timeouts. Disable them —
  // this is a localhost gateway, not an internet-facing server.
  server.timeout = 0 // no socket inactivity timeout
  server.requestTimeout = 0 // no cap on how long a request may take
  server.headersTimeout = 0 // no cap on time-to-headers
  server.keepAliveTimeout = 60_000
  // The paired browser extension's live socket (extension-bridge/). Every other upgrade is refused.
  server.on('upgrade', (req, socket, head) => {
    if (!handleExtensionUpgrade(req, socket, head)) socket.destroy()
  })

  // API authentication is optional. Keep the existing bind policy so no
  // route can become LAN-accessible through a missing per-handler authorization check.
  // Resolve only AFTER the socket actually binds; a bind failure must reject and clear state so
  // callers (which .catch it) can surface the failure and a later restart can retry — rather than a
  // resolved promise leaving a dead `server` set forever and IPC reporting a false success.
  const listening = server
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => {
        listening.removeListener('listening', onListening)
        reject(e)
      }
      const onListening = (): void => {
        listening.removeListener('error', onError)
        // Hand ongoing runtime errors to the logger now that startup succeeded.
        listening.on('error', (e) => console.error('[model-server]', e))
        console.log(
          `[model-server] multimodal gateway at http://${GATEWAY_HOST}:${boundGatewayPort}/v1`
        )
        logActionTokenForDev(`http://${GATEWAY_HOST}:${boundGatewayPort}/mcp`)
        resolve()
      }
      listening.once('error', onError)
      listening.once('listening', onListening)
      listening.listen(boundGatewayPort, GATEWAY_BIND_HOST)
    })
  } catch (e) {
    // Bind failed — drop the dead server and reset so a retry starts clean.
    server = null
    boundGatewayPort = GATEWAY_PORT
    throw e
  } finally {
    startingGateway = false
  }
}

export function stopModelServer(): void {
  shutdownKeepLoaded()
  server?.close()
  server = null
  keepAwake?.release()
}

// ─── Keeping a Team server awake ─────────────────────────────────────────────
let keepAwake: TeamKeepAwake | null = null

/** The host hands over its sleep blocker (Electron's powerSaveBlocker; a headless Node host may
 *  have none). While Team mode has requests in flight the machine stays awake; it may sleep again
 *  a minute after the last one, at once in single mode, and when the gateway stops. */
export function setGatewayPowerBlocker(blocker: PowerBlocker | null): void {
  keepAwake?.release()
  keepAwake = blocker ? new TeamKeepAwake(blocker, TEAM_KEEP_AWAKE_GRACE_MS) : null
  setLimiterActivityListener(
    keepAwake ? (running) => keepAwake?.update(teamMode(), running > 0) : null
  )
  // Switching to single mode lets the machine sleep at once; to team, it follows the work.
  llm.onGatewayModeChange(
    keepAwake ? (mode) => keepAwake?.update(mode === 'team', limiterRunning() > 0) : null
  )
}
