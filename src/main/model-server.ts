// Off Grid local inference gateway — ONE OpenAI-compatible endpoint for every
// modality, on 127.0.0.1:7878. Any local tool (IDE, app, script — or a paired
// device later) points here and gets the on-device models. No cloud, no keys.
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

import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { desktopExtraction } from './rag/extractors';
import * as tts from './tts';
import { generateImage, imageGenStatus, activeImageModel, type ImageGenParams } from './imagegen';
import { whisperModel } from './rag/extractors';
import { getActiveModal } from './active-models';
import { embeddings } from './embeddings';
import { docsText, docsHtml, openApiSpec } from './api-docs';
import { handleMcpRequest } from './mcp-server';

const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 8439; // bundled llama-server (see llm.ts)
const MAX_UPLOAD = 200 * 1024 * 1024; // 200MB upload cap (audio / init image)

let server: http.Server | null = null;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function errBody(message: string, type = 'invalid_request_error') {
  return { error: { message, type } };
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

type ReqStatus = 'queued' | 'running' | 'completed' | 'failed';

interface ApiRequest {
  id: string;
  kind: string; // chat | embedding | transcription | speech | image
  collection: string; // RESTful base path the resource lives under
  status: ReqStatus;
  created_at: number;
  updated_at: number;
  result?: unknown;
  error?: { message: string; type: string };
}

const requests = new Map<string, ApiRequest>();
const REQUESTS_MAX = 500;

function createRequest(id: string, kind: string, collection: string): ApiRequest {
  if (requests.size >= REQUESTS_MAX) {
    const oldest = requests.keys().next().value;
    if (oldest) requests.delete(oldest);
  }
  const now = Date.now();
  const r: ApiRequest = { id, kind, collection, status: 'queued', created_at: now, updated_at: now };
  requests.set(id, r);
  return r;
}

function errMeta(e: unknown): { status: number; type: string; message: string } {
  const status = (e as { status?: number } | undefined)?.status ?? 500;
  const message = e instanceof Error ? e.message : String(e);
  const type =
    status === 501 ? 'not_installed' : status === 502 ? 'upstream_error' : status === 400 ? 'invalid_request_error' : 'server_error';
  return { status, type, message };
}

/** Move a request through running → completed/failed around the work promise. */
function settle<T>(r: ApiRequest, work: Promise<T>): Promise<T> {
  r.status = 'running';
  r.updated_at = Date.now();
  return work.then(
    (result) => {
      r.status = 'completed';
      r.result = result;
      r.updated_at = Date.now();
      return result;
    },
    (e) => {
      const { type, message } = errMeta(e);
      r.status = 'failed';
      r.error = { message, type };
      r.updated_at = Date.now();
      throw e;
    }
  );
}

/** Did the caller ask for async handling? */
function isAsync(req: http.IncomingMessage, payload?: Record<string, unknown>, fields?: Record<string, string>): boolean {
  const q = (req.url || '').split('?')[1] || '';
  if (/(^|&)async=(1|true|yes)(&|$)/i.test(q)) return true;
  const h = String(req.headers['x-async'] || '').toLowerCase();
  if (h === 'true' || h === '1') return true;
  if (/respond-async/i.test(String(req.headers['prefer'] || ''))) return true;
  if (payload && payload.async === true) return true;
  if (fields && /^(1|true|yes)$/i.test(fields.async || '')) return true;
  return false;
}

/** 202 Accepted with the request resource + Location for polling. */
function dispatchAsync(res: http.ServerResponse, r: ApiRequest): void {
  const pollUrl = `${r.collection}/${r.id}`;
  res.setHeader('Location', pollUrl);
  json(res, 202, {
    request_id: r.id,
    object: 'request',
    kind: r.kind,
    status: r.status,
    poll_url: pollUrl,
    created_at: r.created_at,
  });
}

/** GET a request resource — the RESTful poll. */
function handlePoll(res: http.ServerResponse, id: string): void {
  const r = requests.get(id);
  if (!r) {
    json(res, 404, errBody(`No request with id '${id}'.`, 'not_found'));
    return;
  }
  const body: Record<string, unknown> = {
    request_id: r.id,
    object: 'request',
    kind: r.kind,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    poll_url: `${r.collection}/${r.id}`,
  };
  if (r.status === 'completed') body.result = r.result;
  if (r.status === 'failed') body.error = r.error;
  json(res, 200, body);
}

// Collections whose `<collection>/{id}` GET path resolves to a request resource.
const POLL_COLLECTIONS = [
  '/v1/images',
  '/v1/images/generations',
  '/v1/images/edits',
  '/v1/chat/completions',
  '/v1/embeddings',
  '/v1/audio/speech',
  '/v1/audio/transcriptions',
];

// Proxy a request to the local llama-server (response streaming preserved).
// If `bodyOverride` is supplied, that buffer is sent as the request body (used
// when we rewrite chat messages to inline remote images); otherwise the incoming
// request is piped straight through.
//
// When a buffer is supplied the request is replayable, so on a connection error
// (llama-server briefly down while it reloads after image generation) we wait and
// retry until `retryUntil` rather than failing the caller with a 502. Piped
// (streamed) requests can't be replayed, so they fail fast.
function proxyToLlama(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  bodyOverride?: Buffer,
  retryUntil = 0
): void {
  const headers = { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` };
  if (bodyOverride) {
    headers['content-length'] = String(bodyOverride.length);
    delete headers['transfer-encoding'];
  }
  const proxyReq = http.request(
    { hostname: UPSTREAM_HOST, port: UPSTREAM_PORT, path: req.url, method: req.method, headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', () => {
    if (bodyOverride && Date.now() < retryUntil) {
      setTimeout(() => proxyToLlama(req, res, bodyOverride, retryUntil), 1000);
    } else {
      json(res, 502, errBody('Local model not ready (llama-server unavailable).', 'upstream_error'));
    }
  });
  if (bodyOverride) {
    proxyReq.end(bodyOverride);
  } else {
    req.pipe(proxyReq);
  }
}

// Fetch an image reference into a Buffer. Accepts data: URLs, http(s):// URLs,
// and file:// / bare local paths. Matches OpenRouter's "URLs preferred, base64
// for local files" convention so the same payloads work against this gateway.
function fetchImage(ref: string): Promise<{ data: Buffer; mime: string }> {
  const url = ref.trim();
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const mime = /data:([^;,]+)/.exec(url)?.[1] || 'image/png';
    const meta = url.slice(5, comma);
    const raw = url.slice(comma + 1);
    const data = meta.includes('base64') ? Buffer.from(raw, 'base64') : Buffer.from(decodeURIComponent(raw));
    return Promise.resolve({ data, mime });
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const client = url.startsWith('https://') ? https : http;
    return new Promise((resolve, reject) => {
      const r = client.get(url, (resp) => {
        if ((resp.statusCode || 0) >= 400) {
          reject(new Error(`fetch ${url} -> HTTP ${resp.statusCode}`));
          resp.resume();
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        resp.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_UPLOAD) {
            reject(new Error('remote image too large'));
            resp.destroy();
            return;
          }
          chunks.push(c);
        });
        resp.on('end', () => resolve({ data: Buffer.concat(chunks), mime: String(resp.headers['content-type'] || 'image/png') }));
      });
      r.on('error', reject);
    });
  }
  const p = url.startsWith('file://') ? url.slice(7) : url;
  const ext = path.extname(p).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  return fs.promises.readFile(p).then((data) => ({ data, mime }));
}

function toDataUrl(data: Buffer, mime: string): string {
  return `data:${mime};base64,${data.toString('base64')}`;
}

// Round to a multiple of 64 (diffusion models require it), clamped sane.
function round64(n: number): number {
  return Math.max(256, Math.min(2048, Math.round(n / 64) * 64));
}

// Resolve output dimensions from any of: explicit width/height, an OpenAI
// "WIDTHxHEIGHT" size, or an OpenRouter aspect_ratio + resolution pair.
function resolveDims(p: {
  width?: unknown;
  height?: unknown;
  size?: unknown;
  aspect_ratio?: unknown;
  resolution?: unknown;
}): { width?: number; height?: number } {
  if (typeof p.width === 'number' && typeof p.height === 'number') return { width: p.width, height: p.height };
  const fromSize = parseSize(p.size);
  if (fromSize.width && fromSize.height) return fromSize;
  if (typeof p.aspect_ratio === 'string') {
    const m = /^(\d+)\s*[:x×]\s*(\d+)$/.exec(p.aspect_ratio.trim());
    if (m) {
      const ar = parseInt(m[1], 10) / parseInt(m[2], 10);
      const res = String(p.resolution ?? '1K').toUpperCase();
      const base = res === '2K' ? 1536 : res === '512' ? 512 : 1024; // long edge
      const [w, h] = ar >= 1 ? [base, base / ar] : [base * ar, base];
      return { width: round64(w), height: round64(h) };
    }
  }
  return {};
}

function readBody(req: http.IncomingMessage, cap: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > cap) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req, MAX_UPLOAD);
  if (!body.length) return {};
  return JSON.parse(body.toString('utf8'));
}

// Minimal multipart/form-data parser — pulls out uploaded file(s) + text fields
// (avoids adding a dependency for the upload endpoints). Keeps every file part
// keyed by its form field name so img2img can grab `image` specifically.
function parseMultipart(
  body: Buffer,
  contentType: string
): { files: Record<string, { filename: string; data: Buffer }>; fields: Record<string, string> } {
  const out: { files: Record<string, { filename: string; data: Buffer }>; fields: Record<string, string> } = {
    files: {},
    fields: {},
  };
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return out;
  const boundary = (m[1] || m[2]).trim();
  const delim = Buffer.from('--' + boundary);
  const headSep = Buffer.from('\r\n\r\n');
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    let partStart = pos + delim.length;
    if (body[partStart] === 0x2d && body[partStart + 1] === 0x2d) break; // closing "--"
    partStart += 2; // skip CRLF after boundary
    const next = body.indexOf(delim, partStart);
    if (next === -1) break;
    const part = body.slice(partStart, next - 2); // drop trailing CRLF
    const sep = part.indexOf(headSep);
    if (sep !== -1) {
      const headers = part.slice(0, sep).toString('utf8');
      const content = part.slice(sep + headSep.length);
      const fileM = /filename="([^"]*)"/i.exec(headers);
      const nameM = /name="([^"]*)"/i.exec(headers);
      const field = nameM ? nameM[1] : '';
      if (fileM && fileM[1]) {
        out.files[field || fileM[1]] = { filename: fileM[1], data: content };
      } else if (field) {
        out.fields[field] = content.toString('utf8');
      }
    }
    pos = next;
  }
  return out;
}

/** Parse an OpenAI "WIDTHxHEIGHT" size string. */
function parseSize(size: unknown): { width?: number; height?: number } {
  if (typeof size !== 'string') return {};
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(size.trim());
  if (!m) return {};
  return { width: parseInt(m[1], 10), height: parseInt(m[2], 10) };
}

// ─── Text(+image) → text (chat, proxied) ─────────────────────────────────────
// Walk an OpenAI chat body and replace any remote/file image_url with an inlined
// base64 data URL (llama-server only accepts data URLs). Returns true if changed.
async function inlineChatImages(body: unknown): Promise<boolean> {
  if (!body || typeof body !== 'object') return false;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return false;
  let changed = false;
  for (const msg of messages) {
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as { type?: string; image_url?: { url?: string } };
      const url = p.type === 'image_url' ? p.image_url?.url : undefined;
      if (url && !url.startsWith('data:')) {
        const { data, mime } = await fetchImage(url);
        p.image_url!.url = toDataUrl(data, mime);
        changed = true;
      }
    }
  }
  return changed;
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
  run: () => Promise<unknown>,
  syncRespond: (result: unknown) => void
): Promise<void> {
  const r = createRequest(rid, kind, collection);
  if (asyncFlag) {
    settle(r, run()).catch(() => {}); // errors captured on the request resource
    dispatchAsync(res, r);
    return;
  }
  try {
    const result = await settle(r, run());
    syncRespond(result);
  } catch (e) {
    const { status, type, message } = errMeta(e);
    json(res, status, errBody(message, type));
  }
}

/** Merge the request id into a JSON result body (sync responder for JSON ops). */
function jsonWithId(res: http.ServerResponse, rid: string, result: unknown): void {
  json(res, 200, { request_id: rid, ...(result as Record<string, unknown>) });
}

// Non-streaming chat call to llama-server returning parsed JSON (used for async
// chat). Retries through a brief reload window like the streaming proxy does.
function callLlamaJson(bodyObj: Record<string, unknown>, retryUntil: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({ ...bodyObj, stream: false }));
    const upstream = http.request(
      {
        hostname: UPSTREAM_HOST,
        port: UPSTREAM_PORT,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
      },
      (resp) => {
        const chunks: Buffer[] = [];
        resp.on('data', (c: Buffer) => chunks.push(c));
        resp.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if ((resp.statusCode || 0) >= 400) {
              const err = new Error(parsed?.error?.message || 'upstream error') as Error & { status?: number };
              err.status = resp.statusCode;
              reject(err);
            } else resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    upstream.on('error', () => {
      if (Date.now() < retryUntil) {
        setTimeout(() => callLlamaJson(bodyObj, retryUntil).then(resolve, reject), 1000);
      } else {
        const err = new Error('Local model not ready (llama-server unavailable).') as Error & { status?: number };
        err.status = 502;
        reject(err);
      }
    });
    upstream.end(payload);
  });
}

async function handleChat(req: http.IncomingMessage, res: http.ServerResponse, rid: string): Promise<void> {
  let buf: Buffer;
  try {
    buf = await readBody(req, MAX_UPLOAD);
  } catch {
    json(res, 413, errBody('Request too large.'));
    return;
  }
  let body: Record<string, unknown> | null = null;
  let forward: Buffer = buf;
  try {
    body = JSON.parse(buf.toString('utf8'));
    if (await inlineChatImages(body)) forward = Buffer.from(JSON.stringify(body));
  } catch {
    // Not JSON, or image fetch failed — forward the original bytes untouched.
  }

  // Async chat: run a non-streaming completion in the background and poll for it.
  if (body && isAsync(req, body)) {
    const inlined = body;
    await serve(res, rid, 'chat', '/v1/chat/completions', true, () => callLlamaJson(inlined, Date.now() + 45_000), () => {});
    return;
  }

  // Sync: stream straight through. Retry for up to 45s if llama-server is mid-reload
  // (e.g. just after an image generation freed and is respawning it, ~16s).
  res.setHeader('X-Request-Id', rid);
  proxyToLlama(req, res, forward, Date.now() + 45_000);
}

// ─── Embeddings (local MiniLM) ───────────────────────────────────────────────
// Served by the in-app embedder (all-MiniLM-L6-v2) rather than proxied to
// llama-server, which isn't started with --embeddings. Same model the RAG/memory
// layer uses, so vectors are consistent across the app.
async function handleEmbeddings(req: http.IncomingMessage, res: http.ServerResponse, rid: string): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await readJson(req);
  } catch {
    json(res, 400, errBody('Invalid JSON body.'));
    return;
  }
  const raw = payload.input;
  const inputs = Array.isArray(raw) ? raw.map(String) : raw != null ? [String(raw)] : [];
  if (!inputs.length) {
    json(res, 400, errBody('Field "input" (string or array of strings) is required.'));
    return;
  }
  const run = async (): Promise<unknown> => {
    const data: { object: string; index: number; embedding: number[] }[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const embedding = await embeddings.generateEmbedding(inputs[i]);
      data.push({ object: 'embedding', index: i, embedding });
    }
    return { object: 'list', data, model: 'all-MiniLM-L6-v2', usage: { prompt_tokens: 0, total_tokens: 0 } };
  };
  await serve(res, rid, 'embedding', '/v1/embeddings', isAsync(req, payload), run, (result) => jsonWithId(res, rid, result));
}

// ─── Models list (all modalities) ────────────────────────────────────────────
// One ACTIVE model per modality is served on demand: a request loads it, returns,
// then it's offloaded — models never co-reside in RAM (that's why long calls hand
// back a request id to poll). So /v1/models reports the *active* pick per modality
// — what an incoming request would actually load — not every installed file.
// llama-server's own /v1/models only knows the loaded text/vision LLM; we fetch
// that and fold in the active image, speech (TTS), and transcription (STT) models.
// Each entry carries a non-standard `kind` (chat/vision/image/speech/transcription).
function fetchUpstreamModels(): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const r = http.request(
      { hostname: UPSTREAM_HOST, port: UPSTREAM_PORT, path: '/v1/models', method: 'GET' },
      (pr) => {
        let b = '';
        pr.on('data', (d) => (b += d));
        pr.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
      }
    );
    r.on('error', () => resolve({}));
    r.end();
  });
}

async function handleModelsList(res: http.ServerResponse): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const upstream = await fetchUpstreamModels();
  const upData = Array.isArray(upstream.data) ? (upstream.data as Record<string, unknown>[]) : [];
  // Tag the LLM entries chat vs vision from their advertised capabilities.
  const text: Record<string, unknown>[] = upData.map((m) => {
    const caps = Array.isArray(m.capabilities) ? (m.capabilities as string[]) : [];
    return { ...m, kind: caps.includes('multimodal') || caps.includes('vision') ? 'vision' : 'chat' };
  });

  const tag = (id: string, kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
    ({ id, object: 'model', created: now, owned_by: 'off-grid', kind, ...extra });

  // Active image model (chosen pick, else the resolver default).
  const imgId = activeImageModel();
  const images = imgId ? [tag(imgId, 'image')] : [];

  // Active speech (TTS) model + its available voices.
  let voices: string[] = [];
  try { voices = await tts.listVoices(); } catch { /* TTS may be unavailable */ }
  const speechId = getActiveModal('speech') || (voices.length ? 'kokoro' : null);
  const speech = speechId ? [tag(speechId, 'speech', { voices })] : [];

  // Active transcription (STT) model (chosen pick, else the resolved whisper model).
  const sttId = getActiveModal('transcription') || (whisperModel() ? path.basename(whisperModel() as string) : null);
  const transcription = sttId ? [tag(sttId, 'transcription')] : [];

  const data: Record<string, unknown>[] = [...text, ...images, ...speech, ...transcription];
  // Mirror into the ollama-style `models` array some clients read, so both shapes
  // stay in sync.
  const models = data.map((m) => ({
    name: m.id, model: m.id, type: 'model', kind: m.kind,
  }));
  json(res, 200, { object: 'list', data, models });
}

// ─── Speech-to-text (whisper) ────────────────────────────────────────────────
async function handleTranscription(req: http.IncomingMessage, res: http.ServerResponse, rid: string): Promise<void> {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data')) {
    json(res, 400, errBody('Send multipart/form-data with a "file" field.'));
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req, MAX_UPLOAD);
  } catch {
    json(res, 413, errBody('Audio too large.'));
    return;
  }
  const { files, fields } = parseMultipart(body, ct);
  const file = files.file || Object.values(files)[0];
  if (!file || !file.data.length) {
    json(res, 400, errBody('No audio file in "file" field.'));
    return;
  }
  const ext = path.extname(file.filename) || '.audio';
  const tmp = path.join(os.tmpdir(), `offgrid-stt-${process.pid}-${body.length}${ext}`);
  const run = async (): Promise<unknown> => {
    try {
      await fs.promises.writeFile(tmp, file.data);
      if (!desktopExtraction.transcribeAudio) {
        const err = new Error('Transcription runtime not available.') as Error & { status?: number };
        err.status = 501;
        throw err;
      }
      const text = (await desktopExtraction.transcribeAudio(tmp)).trim();
      return { text };
    } finally {
      fs.promises.unlink(tmp).catch(() => {});
    }
  };
  const wantsText = (fields.response_format || '').toLowerCase() === 'text';
  await serve(res, rid, 'transcription', '/v1/audio/transcriptions', isAsync(req, undefined, fields), run, (result) => {
    if (wantsText) {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Request-Id': rid });
      res.end((result as { text: string }).text);
    } else {
      jsonWithId(res, rid, result);
    }
  });
}

// ─── Text-to-speech (Kokoro) ─────────────────────────────────────────────────
async function handleSpeech(req: http.IncomingMessage, res: http.ServerResponse, rid: string): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await readJson(req);
  } catch {
    json(res, 400, errBody('Invalid JSON body.'));
    return;
  }
  const input = String(payload.input ?? payload.text ?? '').trim();
  if (!input) {
    json(res, 400, errBody('Field "input" (text to speak) is required.'));
    return;
  }
  const voice = typeof payload.voice === 'string' ? payload.voice : undefined;
  const fmt = String(payload.response_format ?? '').toLowerCase();
  const run = async (): Promise<unknown> => {
    const { dataUrl } = await tts.synthesize(input, voice);
    return { audio: dataUrl, format: 'wav' };
  };
  // OpenAI's /v1/audio/speech returns raw audio bytes; honor a JSON-ish
  // response_format with a data URL. (Async results are always the JSON form.)
  await serve(res, rid, 'speech', '/v1/audio/speech', isAsync(req, payload), run, (result) => {
    const dataUrl = (result as { audio: string }).audio;
    if (fmt === 'json' || fmt === 'b64_json') {
      jsonWithId(res, rid, result);
    } else {
      const wav = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length), 'X-Request-Id': rid });
      res.end(wav);
    }
  });
}

// ─── Text-to-image / image-to-image (diffusion) ──────────────────────────────
// Run the diffusion model and return the canonical image result. Throws with a
// .status so failures map to the right HTTP code (501 when no model installed).
// `cleanup` removes any temp init image once the work is done (sync or async).
async function executeImage(
  params: ImageGenParams,
  responseFormat: string,
  cleanup?: () => void
): Promise<unknown> {
  try {
    const status = imageGenStatus();
    if (!status.available) {
      const err = new Error(`Image generation unavailable: ${status.reason}.`) as Error & { status?: number };
      err.status = 501;
      throw err;
    }
    const out = await generateImage(params);
    const b64 = out.dataUrl.slice(out.dataUrl.indexOf(',') + 1);
    const datum =
      responseFormat === 'url'
        ? { url: `file://${out.path}`, seed: out.seed, model: out.model }
        : { b64_json: b64, seed: out.seed, model: out.model };
    return {
      created: Math.floor(Date.now() / 1000),
      data: [datum],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  } finally {
    cleanup?.();
  }
}

async function handleImageGeneration(req: http.IncomingMessage, res: http.ServerResponse, rid: string): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await readJson(req);
  } catch {
    json(res, 400, errBody('Invalid JSON body.'));
    return;
  }
  const prompt = String(payload.prompt ?? '').trim();
  if (!prompt) {
    json(res, 400, errBody('Field "prompt" is required.'));
    return;
  }
  const { width, height } = resolveDims(payload);
  const params: ImageGenParams = {
    prompt,
    negativePrompt: typeof payload.negative_prompt === 'string' ? payload.negative_prompt : undefined,
    width,
    height,
    steps: typeof payload.steps === 'number' ? payload.steps : undefined,
    seed: typeof payload.seed === 'number' ? payload.seed : undefined,
    cfgScale: typeof payload.cfg_scale === 'number' ? payload.cfg_scale : undefined,
    model: typeof payload.model === 'string' ? payload.model : undefined,
  };
  const fmt = String(payload.response_format ?? 'b64_json');
  await serve(res, rid, 'image', '/v1/images/generations', isAsync(req, payload), () => executeImage(params, fmt), (r) => jsonWithId(res, rid, r));
}

// OpenRouter-style unified image endpoint: text-to-image, and image-to-image via
// `input_references` (data URLs, http(s) URLs, or local paths) — all over JSON,
// no multipart needed.  POST /v1/images
async function handleImagesUnified(req: http.IncomingMessage, res: http.ServerResponse, rid: string): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await readJson(req);
  } catch {
    json(res, 400, errBody('Invalid JSON body.'));
    return;
  }
  const prompt = String(payload.prompt ?? '').trim();
  if (!prompt) {
    json(res, 400, errBody('Field "prompt" is required.'));
    return;
  }
  const { width, height } = resolveDims(payload);
  const params: ImageGenParams = {
    prompt,
    negativePrompt: typeof payload.negative_prompt === 'string' ? payload.negative_prompt : undefined,
    width,
    height,
    steps: typeof payload.steps === 'number' ? payload.steps : undefined,
    seed: typeof payload.seed === 'number' ? payload.seed : undefined,
    cfgScale: typeof payload.cfg_scale === 'number' ? payload.cfg_scale : undefined,
    model: typeof payload.model === 'string' ? payload.model : undefined,
    strength: typeof payload.strength === 'number' ? payload.strength : undefined,
  };

  // image-to-image: first input_reference becomes the init image.
  let tmp: string | null = null;
  const refs = payload.input_references;
  const firstRef = Array.isArray(refs) ? refs[0] : undefined;
  const refUrl =
    typeof firstRef === 'string'
      ? firstRef
      : (firstRef as { image_url?: { url?: string } } | undefined)?.image_url?.url;
  try {
    if (refUrl) {
      const { data, mime } = await fetchImage(refUrl);
      const ext = mime.includes('jpeg') ? '.jpg' : mime.includes('webp') ? '.webp' : '.png';
      tmp = path.join(os.tmpdir(), `offgrid-imgref-${process.pid}-${data.length}${ext}`);
      await fs.promises.writeFile(tmp, data);
      params.initImage = tmp;
    }
  } catch (e) {
    json(res, 500, errBody(e instanceof Error ? e.message : 'failed to load input_reference', 'server_error'));
    return;
  }
  const cleanup = (): void => {
    if (tmp) fs.promises.unlink(tmp).catch(() => {});
  };
  const fmt = String(payload.response_format ?? 'b64_json');
  await serve(res, rid, 'image', '/v1/images', isAsync(req, payload), () => executeImage(params, fmt, cleanup), (r) => jsonWithId(res, rid, r));
}

async function handleImageEdit(req: http.IncomingMessage, res: http.ServerResponse, rid: string): Promise<void> {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data')) {
    json(res, 400, errBody('Send multipart/form-data with an "image" file and a "prompt" field.'));
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req, MAX_UPLOAD);
  } catch {
    json(res, 413, errBody('Image too large.'));
    return;
  }
  const { files, fields } = parseMultipart(body, ct);
  const image = files.image || Object.values(files)[0];
  if (!image || !image.data.length) {
    json(res, 400, errBody('No init image in "image" field.'));
    return;
  }
  const prompt = (fields.prompt || '').trim();
  if (!prompt) {
    json(res, 400, errBody('Field "prompt" is required.'));
    return;
  }
  const ext = path.extname(image.filename) || '.png';
  const tmp = path.join(os.tmpdir(), `offgrid-img2img-${process.pid}-${body.length}${ext}`);
  await fs.promises.writeFile(tmp, image.data);
  const { width, height } = resolveDims({
    width: fields.width ? parseInt(fields.width, 10) : undefined,
    height: fields.height ? parseInt(fields.height, 10) : undefined,
    size: fields.size,
    aspect_ratio: fields.aspect_ratio,
    resolution: fields.resolution,
  });
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
  };
  const cleanup = (): void => {
    fs.promises.unlink(tmp).catch(() => {});
  };
  const fmt = String(fields.response_format ?? 'b64_json');
  await serve(res, rid, 'image', '/v1/images/edits', isAsync(req, undefined, fields), () => executeImage(params, fmt, cleanup), (r) => jsonWithId(res, rid, r));
}

// ─── Server ──────────────────────────────────────────────────────────────────
/** Start the unified local model gateway. Bound to loopback (local-only). */
export function startModelServer(port = 7878): void {
  if (server) return;

  server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = (req.url || '/').split('?')[0];
    const method = req.method || 'GET';

    // Every request gets a stable id — returned as X-Request-Id and reused as the
    // poll id for async work, so any request can be tracked/polled by the same id.
    const rid = randomUUID();
    res.setHeader('X-Request-Id', rid);

    // RESTful polling: GET the request resource. Canonical /v1/requests/{id}, or
    // the per-collection resource (e.g. /v1/images/{id}, /v1/audio/speech/{id}).
    if (method === 'GET') {
      const slash = url.lastIndexOf('/');
      const prefix = url.slice(0, slash);
      const id = url.slice(slash + 1);
      if (url.startsWith('/v1/requests/') && id) return handlePoll(res, id);
      if (id && POLL_COLLECTIONS.includes(prefix) && requests.has(id)) return handlePoll(res, id);
    }

    if (url === '/' || url === '/health') {
      const img = imageGenStatus();
      json(res, 200, {
        name: 'Off Grid AI — local model gateway',
        openai_compatible: true,
        base_url: `http://127.0.0.1:${port}/v1`,
        docs: `http://127.0.0.1:${port}/docs`,
        mcp: `http://127.0.0.1:${port}/mcp`,
        modalities: {
          text: 'ready',
          vision_understanding: 'ready',
          embeddings: 'ready',
          transcription: 'ready',
          speech: 'ready',
          image_generation: img.available ? 'ready' : 'not_installed',
          image_edit: img.available ? 'ready' : 'not_installed',
        },
        image_models: img.models,
        image_reason: img.available ? undefined : img.reason,
      });
      return;
    }

    if (url === '/openapi.json') {
      const img = imageGenStatus();
      const mods = {
        text: 'ready',
        vision_understanding: 'ready',
        embeddings: 'ready',
        transcription: 'ready',
        speech: 'ready',
        image_generation: img.available ? 'ready' : 'not_installed',
      };
      json(res, 200, openApiSpec(port, mods, img.models));
      return;
    }

    if (url === '/docs') {
      // Browsers get the interactive Scalar playground; curl/SDKs get plain text.
      const wantsHtml = (req.headers.accept || '').includes('text/html');
      if (wantsHtml) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(docsHtml(port));
      } else {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(docsText(port));
      }
      return;
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
        ],
        docs: `http://127.0.0.1:${port}/docs`,
      });
      return;
    }

    // MCP server — on-device models as MCP tools (Streamable HTTP, stateless).
    // POST carries JSON-RPC; the SDK transport needs the parsed body.
    if (url === '/mcp') {
      if (method === 'POST') {
        void readBody(req, MAX_UPLOAD)
          .then((buf) => {
            let parsed: unknown = undefined;
            try {
              parsed = buf.length ? JSON.parse(buf.toString('utf8')) : undefined;
            } catch {
              /* let the transport reject malformed JSON */
            }
            return handleMcpRequest(req, res, parsed);
          })
          .catch((e) => json(res, 500, errBody(e instanceof Error ? e.message : 'mcp error', 'server_error')));
        return;
      }
      // GET/DELETE in stateless mode have no session to attach to.
      json(res, 405, errBody('MCP endpoint accepts POST (stateless Streamable HTTP).', 'method_not_allowed'));
      return;
    }

    if (url === '/v1/requests' && method === 'GET') {
      json(res, 200, {
        object: 'list',
        data: [...requests.values()].map((r) => ({ request_id: r.id, kind: r.kind, status: r.status, poll_url: `${r.collection}/${r.id}` })),
      });
      return;
    }

    if (url === '/v1/embeddings' && method === 'POST') return void handleEmbeddings(req, res, rid);
    if (url === '/v1/audio/transcriptions' && method === 'POST') return void handleTranscription(req, res, rid);
    if (url === '/v1/audio/speech' && method === 'POST') return void handleSpeech(req, res, rid);
    if (url === '/v1/audio/voices' && method === 'GET') {
      void tts
        .listVoices()
        .then((voices) => json(res, 200, { voices }))
        .catch((e) => json(res, 500, errBody(e instanceof Error ? e.message : 'failed to list voices', 'server_error')));
      return;
    }
    if (url === '/v1/images' && method === 'POST') return void handleImagesUnified(req, res, rid);
    if (url === '/v1/images/generations' && method === 'POST') return void handleImageGeneration(req, res, rid);
    if (url === '/v1/images/edits' && method === 'POST') return void handleImageEdit(req, res, rid);

    // Chat (text + image-to-text): buffer so we can inline remote image URLs,
    // which llama-server can't fetch itself, then forward (response still streams).
    if (url === '/v1/chat/completions' && method === 'POST') return void handleChat(req, res, rid);
    // Full local model surface across all modalities (not just the LLM).
    if (url === '/v1/models' && method === 'GET') return void handleModelsList(res);

    // Everything else (completions/embeddings) -> llama-server.
    proxyToLlama(req, res);
  });

  // Long-running modalities (first-run model downloads, multi-step diffusion,
  // streamed chat) must not be severed by idle/header timeouts. Disable them —
  // this is a localhost gateway, not an internet-facing server.
  server.timeout = 0; // no socket inactivity timeout
  server.requestTimeout = 0; // no cap on how long a request may take
  server.headersTimeout = 0; // no cap on time-to-headers
  server.keepAliveTimeout = 60_000;

  server.on('error', (e) => console.error('[model-server]', e));
  server.listen(port, '127.0.0.1', () => {
    console.log(`[model-server] multimodal gateway at http://127.0.0.1:${port}/v1`);
  });
}

export function stopModelServer(): void {
  server?.close();
  server = null;
}
