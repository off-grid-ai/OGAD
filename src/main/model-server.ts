// Off Grid local inference gateway — ONE OpenAI-compatible endpoint for every
// modality, on 127.0.0.1:7878. Any local tool (IDE, app, script — or a paired
// device later) points here and gets the on-device models. No cloud, no keys.
//
//   /v1/chat/completions   -> proxied to the bundled llama-server (text + vision-in)
//   /v1/completions        -> proxied to llama-server
//   /v1/embeddings         -> proxied to llama-server
//   /v1/models             -> proxied to llama-server
//   /v1/audio/transcriptions -> whisper.cpp (speech -> text), multilingual
//   /v1/audio/speech       -> TTS (501 until a voice model is installed)
//   /v1/images/generations -> diffusion (501 until an image model is installed)
//
// Modalities we can't serve yet are wired and return an honest 501 with a
// message, so the surface is stable and clients fail clearly.

import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { desktopExtraction } from './rag/extractors';

const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 8439; // bundled llama-server (see llm.ts)
const MAX_UPLOAD = 200 * 1024 * 1024; // 200MB audio cap

let server: http.Server | null = null;

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Proxy a request straight through to the local llama-server (streaming included).
function proxyToLlama(req: http.IncomingMessage, res: http.ServerResponse): void {
  const proxyReq = http.request(
    {
      hostname: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `${UPSTREAM_HOST}:${UPSTREAM_PORT}` },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', () =>
    json(res, 502, { error: { message: 'Local model not ready (llama-server unavailable).' } })
  );
  req.pipe(proxyReq);
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

// Minimal multipart/form-data parser — pulls out the uploaded file + text fields
// (avoids adding a dependency for the one transcription endpoint).
function parseMultipart(body: Buffer, contentType: string): { filename?: string; data?: Buffer; fields: Record<string, string> } {
  const out: { filename?: string; data?: Buffer; fields: Record<string, string> } = { fields: {} };
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
      if (fileM && fileM[1]) {
        out.filename = fileM[1];
        out.data = content;
      } else if (nameM) {
        out.fields[nameM[1]] = content.toString('utf8');
      }
    }
    pos = next;
  }
  return out;
}

// OpenAI-compatible speech-to-text via the bundled whisper pipeline.
async function handleTranscription(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('multipart/form-data')) {
    json(res, 400, { error: { message: 'Send multipart/form-data with a "file" field.' } });
    return;
  }
  let body: Buffer;
  try {
    body = await readBody(req, MAX_UPLOAD);
  } catch {
    json(res, 413, { error: { message: 'Audio too large.' } });
    return;
  }
  const { data, filename, fields } = parseMultipart(body, ct);
  if (!data || !data.length) {
    json(res, 400, { error: { message: 'No audio file in "file" field.' } });
    return;
  }
  const ext = (filename && path.extname(filename)) || '.audio';
  const tmp = path.join(os.tmpdir(), `offgrid-stt-${process.pid}-${body.length}${ext}`);
  try {
    await fs.promises.writeFile(tmp, data);
    if (!desktopExtraction.transcribeAudio) {
      json(res, 501, { error: { message: 'Transcription runtime not available.' } });
      return;
    }
    const text = (await desktopExtraction.transcribeAudio(tmp)).trim();
    if ((fields.response_format || '').toLowerCase() === 'text') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(text);
    } else {
      json(res, 200, { text });
    }
  } catch (e) {
    json(res, 500, { error: { message: e instanceof Error ? e.message : 'transcription failed' } });
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

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

    if (url === '/' || url === '/health') {
      json(res, 200, {
        name: 'Off Grid AI Desktop — local model gateway',
        openai_compatible: true,
        base_url: `http://127.0.0.1:${port}/v1`,
        modalities: {
          text: 'ready',
          vision_understanding: 'ready',
          embeddings: 'ready',
          transcription: 'ready',
          speech: 'not_installed',
          image_generation: 'not_installed',
        },
      });
      return;
    }

    if (url === '/v1/audio/transcriptions' && req.method === 'POST') {
      void handleTranscription(req, res);
      return;
    }
    if (url === '/v1/audio/speech') {
      json(res, 501, { error: { message: 'Text-to-speech is not installed yet (no voice model).' } });
      return;
    }
    if (url === '/v1/images/generations') {
      json(res, 501, { error: { message: 'Image generation is not installed yet (no diffusion model).' } });
      return;
    }

    // Everything else (chat/completions/embeddings/models) -> llama-server.
    proxyToLlama(req, res);
  });

  server.on('error', (e) => console.error('[model-server]', e));
  server.listen(port, '127.0.0.1', () => {
    console.log(`[model-server] multimodal gateway at http://127.0.0.1:${port}/v1`);
  });
}

export function stopModelServer(): void {
  server?.close();
  server = null;
}
