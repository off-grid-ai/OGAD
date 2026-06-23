// Off Grid as an MCP *server*: exposes the on-device models as MCP tools so any
// MCP client (Claude Desktop, IDEs, other local apps) can route inference through
// this machine. Mounted at POST /mcp on the :7878 gateway via the MCP SDK's
// Streamable HTTP transport in stateless JSON mode (one server+transport per
// request — no session state to manage for a single local user).
//
// This is the inverse of mcp.ts (which is the MCP *client* for outbound
// connectors). Everything here runs locally; nothing leaves the device.

import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { llm } from './llm';
import { generateImage, imageGenStatus } from './imagegen';
import * as tts from './tts';
import { embeddings } from './embeddings';
import { desktopExtraction } from './rag/extractors';

// Write a data URL / http(s) URL / file path / bare path to a temp file and
// return its path (for tools that take an image or audio input).
async function materialize(ref: string, fallbackExt: string): Promise<string> {
  const url = ref.trim();
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    const meta = url.slice(5, comma);
    const ext = /(\w+)\/(\w+)/.exec(meta)?.[2] || fallbackExt;
    const data = meta.includes('base64')
      ? Buffer.from(url.slice(comma + 1), 'base64')
      : Buffer.from(decodeURIComponent(url.slice(comma + 1)));
    const p = path.join(os.tmpdir(), `offgrid-mcp-${process.pid}-${Date.now()}.${ext}`);
    await fs.promises.writeFile(p, data);
    return p;
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const client = url.startsWith('https://') ? https : http;
    const data: Buffer = await new Promise((resolve, reject) => {
      client
        .get(url, (resp) => {
          if ((resp.statusCode || 0) >= 400) {
            reject(new Error(`fetch ${url} -> HTTP ${resp.statusCode}`));
            resp.resume();
            return;
          }
          const chunks: Buffer[] = [];
          resp.on('data', (c: Buffer) => chunks.push(c));
          resp.on('end', () => resolve(Buffer.concat(chunks)));
        })
        .on('error', reject);
    });
    const ext = path.extname(new URL(url).pathname).slice(1) || fallbackExt;
    const p = path.join(os.tmpdir(), `offgrid-mcp-${process.pid}-${Date.now()}.${ext}`);
    await fs.promises.writeFile(p, data);
    return p;
  }
  return url.startsWith('file://') ? url.slice(7) : url; // local path, used in place
}

const TEXT = (t: string): { content: { type: 'text'; text: string }[] } => ({ content: [{ type: 'text', text: t }] });

/** Build a fresh MCP server with all on-device tools registered. */
function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'Off Grid AI Desktop', version: '1.0.0' },
    {
      instructions:
        'On-device AI tools served locally by Off Grid AI Desktop — text generation, vision, ' +
        'image generation/editing, transcription, speech, and embeddings. Everything runs on the ' +
        "user's machine; nothing is sent to the cloud.",
    }
  );

  server.registerTool(
    'generate_text',
    {
      title: 'Generate text',
      description: 'Generate text with the local LLM (Off Grid). Supports an optional system prompt.',
      inputSchema: {
        prompt: z.string().describe('The user prompt.'),
        system: z.string().optional().describe('Optional system instruction.'),
        max_tokens: z.number().int().positive().optional(),
      },
    },
    async ({ prompt, system, max_tokens }) => {
      const msg = system ? `${system}\n\n${prompt}` : prompt;
      const text = await llm.chat(msg, [], 300000, max_tokens ?? 2048, { disableThinking: true });
      return TEXT(text);
    }
  );

  server.registerTool(
    'describe_image',
    {
      title: 'Describe / analyze an image',
      description: 'Vision: analyze an image (data URL, http(s) URL, or local path) with the local VLM.',
      inputSchema: {
        image: z.string().describe('Image as a data URL, http(s) URL, or local file path.'),
        prompt: z.string().optional().describe('What to ask about the image. Defaults to a general description.'),
      },
    },
    async ({ image, prompt }) => {
      const p = await materialize(image, 'png');
      const text = await llm.chat(prompt || 'Describe this image in detail.', [p], 300000, 1024, {
        disableThinking: true,
      });
      return TEXT(text);
    }
  );

  server.registerTool(
    'generate_image',
    {
      title: 'Generate an image',
      description: 'Text-to-image with the local diffusion model. Returns a PNG.',
      inputSchema: {
        prompt: z.string(),
        negative_prompt: z.string().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        steps: z.number().int().optional(),
        seed: z.number().int().optional(),
        model: z.string().optional(),
      },
    },
    async ({ prompt, negative_prompt, width, height, steps, seed, model }) => {
      const status = imageGenStatus();
      if (!status.available) throw new Error(`Image generation unavailable: ${status.reason}.`);
      const out = await generateImage({ prompt, negativePrompt: negative_prompt, width, height, steps, seed, model });
      const b64 = out.dataUrl.slice(out.dataUrl.indexOf(',') + 1);
      return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] };
    }
  );

  server.registerTool(
    'edit_image',
    {
      title: 'Edit an image (image-to-image)',
      description: 'Repaint an input image guided by a prompt (img2img) with the local diffusion model.',
      inputSchema: {
        image: z.string().describe('Init image: data URL, http(s) URL, or local path.'),
        prompt: z.string(),
        strength: z.number().min(0).max(1).optional().describe('How far from the init image (default ~0.75).'),
      },
    },
    async ({ image, prompt, strength }) => {
      const status = imageGenStatus();
      if (!status.available) throw new Error(`Image generation unavailable: ${status.reason}.`);
      const initImage = await materialize(image, 'png');
      try {
        const out = await generateImage({ prompt, initImage, strength });
        const b64 = out.dataUrl.slice(out.dataUrl.indexOf(',') + 1);
        return { content: [{ type: 'image', data: b64, mimeType: 'image/png' }] };
      } finally {
        if (initImage.includes('offgrid-mcp-')) fs.promises.unlink(initImage).catch(() => {});
      }
    }
  );

  server.registerTool(
    'transcribe_audio',
    {
      title: 'Transcribe audio (speech-to-text)',
      description: 'Transcribe an audio file (data URL, http(s) URL, or local path) with the local whisper model.',
      inputSchema: { audio: z.string().describe('Audio as a data URL, http(s) URL, or local file path.') },
    },
    async ({ audio }) => {
      if (!desktopExtraction.transcribeAudio) throw new Error('Transcription runtime not available.');
      const p = await materialize(audio, 'wav');
      try {
        const text = (await desktopExtraction.transcribeAudio(p)).trim();
        return TEXT(text);
      } finally {
        if (p.includes('offgrid-mcp-')) fs.promises.unlink(p).catch(() => {});
      }
    }
  );

  server.registerTool(
    'text_to_speech',
    {
      title: 'Text-to-speech',
      description: 'Synthesize speech from text with the local Kokoro voice model. Returns WAV audio.',
      inputSchema: {
        text: z.string(),
        voice: z.string().optional().describe('Voice id, e.g. af_heart (default).'),
      },
    },
    async ({ text, voice }) => {
      const { dataUrl } = await tts.synthesize(text, voice);
      const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      return { content: [{ type: 'audio', data: b64, mimeType: 'audio/wav' }] };
    }
  );

  server.registerTool(
    'embed',
    {
      title: 'Create an embedding',
      description: 'Embed text with the local all-MiniLM-L6-v2 model (384-dim). Returns the vector as JSON.',
      inputSchema: { input: z.string() },
    },
    async ({ input }) => {
      const embedding = await embeddings.generateEmbedding(input);
      return {
        content: [{ type: 'text', text: JSON.stringify(embedding) }],
        structuredContent: { model: 'all-MiniLM-L6-v2', dimensions: embedding.length, embedding },
      };
    }
  );

  return server;
}

/** Handle a single MCP HTTP request (stateless). `body` is the parsed JSON for POST. */
export async function handleMcpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  body: unknown
): Promise<void> {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
