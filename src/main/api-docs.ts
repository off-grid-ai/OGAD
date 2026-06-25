// Self-hosted API documentation for the local model gateway.
//
//   GET /openapi.json -> OpenAPI 3.1 spec describing every endpoint
//   GET /docs         -> Scalar API Reference (interactive playground: try requests,
//                        copy as cURL/Python/JS, browse schemas) rendered from the spec.
//                        curl/SDKs (Accept: */*) get a plain-text quick reference instead.
//
// Scalar loads from a CDN at view time (the docs page only, never the API path).
// The playground calls the live gateway directly — CORS is open on the server.

export function docsText(port: number): string {
  const b = `http://127.0.0.1:${port}`;
  return `Off Grid AI — Local Model Gateway
OpenAI-compatible. Base URL: ${b}/v1  (no API key required)

TEXT -> TEXT          POST ${b}/v1/chat/completions   {model, messages, stream?}
IMAGE -> TEXT         POST ${b}/v1/chat/completions   (image_url part: data URL or http(s) URL)
EMBEDDINGS            POST ${b}/v1/embeddings          {input}  (local all-MiniLM-L6-v2, 384-dim)
SPEECH -> TEXT (STT)  POST ${b}/v1/audio/transcriptions  multipart: file
TEXT -> SPEECH (TTS)  POST ${b}/v1/audio/speech        {input, voice?}  -> audio/wav
  voices              GET  ${b}/v1/audio/voices
TEXT -> IMAGE         POST ${b}/v1/images              {prompt, aspect_ratio?, resolution?, seed?}
IMAGE -> IMAGE        POST ${b}/v1/images              {prompt, input_references:[{image_url:{url}}]}
  (OpenAI aliases)    POST ${b}/v1/images/generations  |  POST ${b}/v1/images/edits (multipart)

Open ${b}/docs in a browser for the interactive playground. Repo: docs/API.md.
`;
}

/** Interactive docs shell (Scalar API Reference) pointed at /openapi.json. */
export function docsHtml(port: number): string {
  const b = `http://127.0.0.1:${port}`;
  return `<!doctype html>
<html lang="en"><head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Off Grid AI — Local API</title>
  <style>
    body{ margin:0; background:#0A0A0A; }
    /* Brand the Scalar theme: Menlo mono + emerald accent + near-black base. */
    :root{
      --scalar-font:'Menlo','SF Mono',monospace;
      --scalar-font-code:'Menlo','SF Mono',monospace;
      --scalar-color-accent:#34D399;
    }
    .dark-mode{
      --scalar-background-1:#0A0A0A; --scalar-background-2:#111; --scalar-background-3:#1a1a1a;
      --scalar-border-color:#222; --scalar-color-accent:#34D399; --scalar-color-1:#e8e8e8; --scalar-color-2:#aaa;
      --scalar-button-1:#34D399; --scalar-button-1-color:#0A0A0A;
    }
  </style>
</head><body>
  <script id="api-reference" data-url="${b}/openapi.json"
          data-configuration='{"theme":"none","darkMode":true,"hideDownloadButton":false,"defaultHttpClient":{"targetKey":"shell","clientKey":"curl"},"hiddenClients":["c","clojure","csharp","go","http","java","kotlin","objc","ocaml","php","powershell","r","ruby","swift","httpie","wget","undici","axios","ofetch","unirest","nsurlsession","asynchttp","nethttp","okhttp","restsharp","native","cohttp","webrequest","jquery","xhr"]}'></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body></html>`;
}

/** OpenAPI 3.1 spec. `modalities`/`imageModels` come from live gateway state. */
export function openApiSpec(
  port: number,
  modalities: Record<string, string>,
  imageModels: string[]
): unknown {
  const ready = (k: string): string => (modalities[k] === 'ready' ? 'ready' : 'not installed');
  const imgEnum = imageModels.length ? { enum: imageModels } : {};

  // Opt-in async: any POST accepts ?async=true (or body async:true / X-Async header)
  // and returns 202 with a request resource you poll via GET /v1/requests/{id}.
  const asyncParam = {
    name: 'async',
    in: 'query',
    required: false,
    schema: { type: 'boolean', default: false },
    description: 'Run asynchronously: returns 202 + a request_id and poll_url instead of waiting for the result.',
  };

  const errorResponse = {
    description: 'Error',
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: { message: { type: 'string' }, type: { type: 'string' } },
            },
          },
        },
      },
    },
  };

  const imageResultSchema = {
    type: 'object',
    properties: {
      created: { type: 'integer' },
      data: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            b64_json: { type: 'string', description: 'Base64-encoded PNG' },
            seed: { type: 'integer' },
            model: { type: 'string' },
          },
        },
      },
      usage: { type: 'object' },
    },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'Off Grid AI — Local Model Gateway',
      version: '1.0.0',
      description: `One **OpenAI-compatible** API for every on-device modality. **No API key** — the server is bound to loopback and nothing leaves the machine.

**Live status:** text: ${ready('text')} · vision: ${ready('vision_understanding')} · embeddings: ${ready('embeddings')} · STT: ${ready('transcription')} · TTS: ${ready('speech')} · image gen: ${ready('image_generation')} · MCP: ready

## Authentication

None. The gateway listens only on \`127.0.0.1\`. Base URL: \`${b(port)}/v1\`. Pass any value (or none) where an SDK expects an API key.

## SDKs

The gateway speaks the OpenAI wire format, so the **universal SDK is the OpenAI SDK** — just point \`base_url\` here and leave the key blank. No Off Grid–specific SDK is required.

\`\`\`python
from openai import OpenAI
client = OpenAI(base_url="${b(port)}/v1", api_key="not-needed")
client.chat.completions.create(model="local", messages=[{"role":"user","content":"hi"}])
\`\`\`

\`\`\`javascript
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "${b(port)}/v1", apiKey: "not-needed" });
\`\`\`

| Surface | SDK | Status |
|---|---|---|
| REST — chat, embeddings, audio, images | OpenAI SDK (Python / JS / Go / Rust / …) | ✅ works today |
| MCP tools | any MCP client · \`@modelcontextprotocol/sdk\` | ✅ works today |
| Off Grid native SDK (thin convenience wrapper) | \`@offgrid/sdk\` | 🚧 coming soon |

## MCP server

Off Grid is **also an MCP server** (Streamable HTTP, stateless) at \`POST ${b(port)}/mcp\`. Any MCP client can run the on-device models as tools — the inference layer for the whole device.

**Tools:** \`generate_text\`, \`describe_image\`, \`generate_image\`, \`edit_image\`, \`transcribe_audio\`, \`text_to_speech\`, \`embed\`.

List the tools:

\`\`\`bash
curl ${b(port)}/mcp \\
  -H 'Content-Type: application/json' \\
  -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
\`\`\`

Call one:

\`\`\`bash
curl ${b(port)}/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"generate_text","arguments":{"prompt":"Write a haiku."}}}'
\`\`\`

Register it with an MCP client (HTTP transport):

\`\`\`json
{ "mcpServers": { "off-grid": { "url": "${b(port)}/mcp" } } }
\`\`\`

## Models

On-device models behind the API (all local; none are cloud-hosted):

| Role | Model | Endpoint |
|---|---|---|
| Text + vision | local VLM — see \`GET /v1/models\` | \`/v1/chat/completions\` |
| Embeddings | all-MiniLM-L6-v2 (384-dim) | \`/v1/embeddings\` |
| Speech → text | whisper.cpp | \`/v1/audio/transcriptions\` |
| Text → speech | Kokoro-82M | \`/v1/audio/speech\` |
| Image (gen + edit) | ${imageModels.length ? imageModels.join(', ') : '_install one from the Models screen_'} | \`/v1/images\` |

## Async & polling

Every response carries an \`X-Request-Id\`. Any POST can run async — \`?async=true\`, body \`"async": true\`, or header \`X-Async: true\` → \`202\` with a \`request_id\` and \`poll_url\`. Poll RESTfully with \`GET /v1/requests/{request_id}\` (canonical) or the per-collection resource (e.g. \`GET /v1/images/{id}\`). There is no \`/poll\` verb — you read the resource.

## Performance & memory

Models swap in/out (Apple Silicon unified memory): image generation pauses the LLM, TTS runs in a killable subprocess, STT is one-shot. HTTP timeouts are disabled so long diffusion runs and first-run downloads complete — use a client timeout ≥120s for images/TTS (or just use async + polling). While the LLM reloads after image gen, chat may briefly return \`502\` — retry after a moment.`,
    },
    servers: [{ url: b(port), description: 'Local gateway (loopback)' }],
    tags: [
      { name: 'Chat', description: 'Text → text and image → text (vision)' },
      { name: 'Embeddings' },
      { name: 'Audio', description: 'Speech-to-text and text-to-speech' },
      { name: 'Images', description: 'Text-to-image and image-to-image' },
      { name: 'Requests', description: 'Poll async requests (request_id)' },
      { name: 'MCP', description: 'Model Context Protocol server — on-device models as MCP tools' },
    ],
    paths: {
      '/v1/chat/completions': {
        post: {
          tags: ['Chat'],
          summary: 'Chat completion (text & vision)',
          parameters: [asyncParam],
          description:
            'OpenAI chat completions. For vision, add an `image_url` content part — the `url` may be a base64 data URL or a remote http(s)/file URL (the gateway fetches & inlines remote images). Set `stream: true` for SSE.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['messages'],
                  properties: {
                    model: { type: 'string', default: 'local' },
                    messages: { type: 'array', items: { type: 'object' } },
                    stream: { type: 'boolean', default: false },
                    max_tokens: { type: 'integer' },
                    temperature: { type: 'number' },
                    response_format: { type: 'object' },
                  },
                },
                examples: {
                  text: {
                    summary: 'Text',
                    value: {
                      model: 'local',
                      messages: [{ role: 'user', content: 'Write a haiku about local AI.' }],
                      chat_template_kwargs: { enable_thinking: false },
                    },
                  },
                  vision: {
                    summary: 'Image → text (vision)',
                    value: {
                      model: 'local',
                      messages: [
                        {
                          role: 'user',
                          content: [
                            { type: 'text', text: 'What is in this image?' },
                            { type: 'image_url', image_url: { url: 'https://example.com/photo.jpg' } },
                          ],
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'OpenAI chat.completion object' }, default: errorResponse },
        },
      },
      '/v1/embeddings': {
        post: {
          tags: ['Embeddings'],
          summary: 'Create embeddings (local all-MiniLM-L6-v2, 384-dim)',
          parameters: [asyncParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['input'],
                  properties: {
                    input: {
                      oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
                    },
                    model: { type: 'string', default: 'all-MiniLM-L6-v2' },
                  },
                },
                example: { input: ['text one', 'text two'] },
              },
            },
          },
          responses: {
            '200': {
              description: 'OpenAI list of embeddings',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            default: errorResponse,
          },
        },
      },
      '/v1/audio/transcriptions': {
        post: {
          tags: ['Audio'],
          summary: 'Speech → text (whisper.cpp)',
          parameters: [asyncParam],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: {
                    file: { type: 'string', format: 'binary', description: 'Audio file (wav/mp3/m4a…)' },
                    response_format: { type: 'string', enum: ['json', 'text'], default: 'json' },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Transcript',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { text: { type: 'string' } } },
                },
              },
            },
            default: errorResponse,
          },
        },
      },
      '/v1/audio/speech': {
        post: {
          tags: ['Audio'],
          summary: 'Text → speech (Kokoro-82M) — returns audio/wav',
          parameters: [asyncParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['input'],
                  properties: {
                    input: { type: 'string', description: 'Text to speak (≤2000 chars)' },
                    voice: { type: 'string', default: 'af_heart' },
                    response_format: {
                      type: 'string',
                      enum: ['wav', 'json'],
                      default: 'wav',
                      description: 'wav → raw bytes; json → { audio: dataURL }',
                    },
                  },
                },
                example: { input: 'Hello from Off Grid.', voice: 'af_heart' },
              },
            },
          },
          responses: {
            '200': {
              description: 'WAV audio',
              content: { 'audio/wav': { schema: { type: 'string', format: 'binary' } } },
            },
            default: errorResponse,
          },
        },
      },
      '/v1/audio/voices': {
        get: {
          tags: ['Audio'],
          summary: 'List TTS voices',
          responses: {
            '200': {
              description: 'Voice ids',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { voices: { type: 'array', items: { type: 'string' } } } },
                },
              },
            },
          },
        },
      },
      '/v1/images': {
        post: {
          tags: ['Images'],
          summary: 'Text → image  &  image → image',
          parameters: [asyncParam],
          description:
            'Include `input_references` to do image-to-image. Returns base64 PNG. Image generation pauses the LLM while it runs (one at a time).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['prompt'],
                  properties: {
                    prompt: { type: 'string' },
                    input_references: {
                      type: 'array',
                      description: 'Init image(s) for image-to-image. data URL, http(s), or file path.',
                      items: {
                        type: 'object',
                        properties: {
                          type: { type: 'string', example: 'image_url' },
                          image_url: { type: 'object', properties: { url: { type: 'string' } } },
                        },
                      },
                    },
                    strength: { type: 'number', description: 'img2img only, 0–1 (default ~0.75)' },
                    aspect_ratio: { type: 'string', example: '16:9' },
                    resolution: { type: 'string', enum: ['512', '1K', '2K'], default: '1K' },
                    size: { type: 'string', example: '1024x1024' },
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                    steps: { type: 'integer' },
                    seed: { type: 'integer' },
                    cfg_scale: { type: 'number' },
                    negative_prompt: { type: 'string' },
                    model: { type: 'string', ...imgEnum },
                    response_format: { type: 'string', enum: ['b64_json', 'url'], default: 'b64_json' },
                  },
                },
                examples: {
                  txt2img: {
                    summary: 'Text → image',
                    value: { prompt: 'a lighthouse at dusk, watercolor', aspect_ratio: '16:9', resolution: '1K' },
                  },
                  img2img: {
                    summary: 'Image → image',
                    value: {
                      prompt: 'make it a snowy winter scene',
                      strength: 0.6,
                      input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }],
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': { description: 'Generated image', content: { 'application/json': { schema: imageResultSchema } } },
            '501': errorResponse,
            default: errorResponse,
          },
        },
      },
      '/v1/images/generations': {
        post: {
          tags: ['Images'],
          summary: 'OpenAI alias — generations (text → image)',
          parameters: [asyncParam],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' }, size: { type: 'string' }, model: { type: 'string', ...imgEnum } } },
                example: { prompt: 'a yellow rubber duck', size: '512x512' },
              },
            },
          },
          responses: { '200': { description: 'Generated image', content: { 'application/json': { schema: imageResultSchema } } }, default: errorResponse },
        },
      },
      '/v1/images/edits': {
        post: {
          tags: ['Images'],
          summary: 'OpenAI alias — edits (image → image, multipart)',
          parameters: [asyncParam],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['image', 'prompt'],
                  properties: {
                    image: { type: 'string', format: 'binary' },
                    prompt: { type: 'string' },
                    strength: { type: 'number' },
                    model: { type: 'string', ...imgEnum },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Edited image', content: { 'application/json': { schema: imageResultSchema } } }, default: errorResponse },
        },
      },
      '/v1/requests/{request_id}': {
        get: {
          tags: ['Requests'],
          summary: 'Poll a request (RESTful)',
          description:
            'Read the status/result of any async request. `status` is queued | running | completed | failed; when completed, `result` holds the modality payload; when failed, `error`.',
          parameters: [{ name: 'request_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'Request resource',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      request_id: { type: 'string' },
                      kind: { type: 'string' },
                      status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed'] },
                      result: { type: 'object' },
                      error: { type: 'object' },
                    },
                  },
                },
              },
            },
            '404': errorResponse,
          },
        },
      },
      '/v1/requests': {
        get: { tags: ['Requests'], summary: 'List recent requests', responses: { '200': { description: 'List of requests' } } },
      },
      '/mcp': {
        post: {
          tags: ['MCP'],
          summary: 'MCP server (JSON-RPC over Streamable HTTP)',
          description:
            'Model Context Protocol endpoint (stateless). Send JSON-RPC: `initialize`, `tools/list`, `tools/call`. ' +
            'Tools: generate_text, describe_image, generate_image, edit_image, transcribe_audio, text_to_speech, embed. ' +
            'Requires `Accept: application/json, text/event-stream`. See the **MCP server** section above for client setup.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/McpRequest' },
                examples: {
                  list: { summary: 'tools/list', value: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } },
                  call: {
                    summary: 'tools/call',
                    value: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate_text', arguments: { prompt: 'Write a haiku.' } } },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'JSON-RPC result' }, default: errorResponse },
        },
      },
      '/health': {
        get: { tags: ['Chat'], summary: 'Gateway health & live modality status', responses: { '200': { description: 'OK' } } },
      },
    },
    components: {
      schemas: {
        Error: {
          type: 'object',
          description: 'OpenAI-style error envelope.',
          properties: { error: { type: 'object', properties: { message: { type: 'string' }, type: { type: 'string' } } } },
        },
        ChatMessage: {
          type: 'object',
          description: 'A chat message. `content` is a string, or an array of parts (text + image_url) for vision.',
          properties: {
            role: { type: 'string', enum: ['system', 'user', 'assistant'] },
            content: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      type: { type: 'string', enum: ['text', 'image_url'] },
                      text: { type: 'string' },
                      image_url: { type: 'object', properties: { url: { type: 'string', description: 'data: URL or http(s)/file URL' } } },
                    },
                  },
                },
              ],
            },
          },
          required: ['role', 'content'],
        },
        ChatCompletionRequest: {
          type: 'object',
          required: ['messages'],
          properties: {
            model: { type: 'string', default: 'local' },
            messages: { type: 'array', items: { $ref: '#/components/schemas/ChatMessage' } },
            stream: { type: 'boolean', default: false },
            max_tokens: { type: 'integer' },
            temperature: { type: 'number' },
            response_format: { type: 'object', description: 'Grammar-constrained JSON / json_schema.' },
          },
        },
        EmbeddingRequest: {
          type: 'object',
          required: ['input'],
          properties: { input: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, model: { type: 'string' } },
        },
        EmbeddingList: {
          type: 'object',
          properties: {
            object: { type: 'string', example: 'list' },
            data: {
              type: 'array',
              items: { type: 'object', properties: { object: { type: 'string' }, index: { type: 'integer' }, embedding: { type: 'array', items: { type: 'number' } } } },
            },
            model: { type: 'string', example: 'all-MiniLM-L6-v2' },
            usage: { type: 'object' },
          },
        },
        ImageRequest: {
          type: 'object',
          required: ['prompt'],
          properties: {
            prompt: { type: 'string' },
            input_references: {
              type: 'array',
              description: 'Init image(s) for image-to-image. Each is { type: image_url, image_url: { url } }.',
              items: { type: 'object', properties: { type: { type: 'string' }, image_url: { type: 'object', properties: { url: { type: 'string' } } } } },
            },
            strength: { type: 'number', description: 'img2img only, 0–1' },
            aspect_ratio: { type: 'string', example: '16:9' },
            resolution: { type: 'string', enum: ['512', '1K', '2K'] },
            size: { type: 'string', example: '1024x1024' },
            steps: { type: 'integer' },
            seed: { type: 'integer' },
            cfg_scale: { type: 'number' },
            negative_prompt: { type: 'string' },
            model: { type: 'string', ...imgEnum },
            response_format: { type: 'string', enum: ['b64_json', 'url'] },
          },
        },
        ImageResult: imageResultSchema,
        SpeechRequest: {
          type: 'object',
          required: ['input'],
          properties: {
            input: { type: 'string' },
            voice: { type: 'string', default: 'af_heart' },
            response_format: { type: 'string', enum: ['wav', 'json'], default: 'wav' },
          },
        },
        TranscriptionResult: { type: 'object', properties: { text: { type: 'string' } } },
        RequestResource: {
          type: 'object',
          description: 'An async request, returned by `?async=true` and read via GET /v1/requests/{id}.',
          properties: {
            request_id: { type: 'string' },
            kind: { type: 'string', enum: ['chat', 'embedding', 'transcription', 'speech', 'image'] },
            status: { type: 'string', enum: ['queued', 'running', 'completed', 'failed'] },
            created_at: { type: 'integer' },
            updated_at: { type: 'integer' },
            poll_url: { type: 'string' },
            result: { type: 'object', description: 'Present when completed — the modality payload.' },
            error: { $ref: '#/components/schemas/Error' },
          },
        },
        McpRequest: {
          type: 'object',
          description: 'JSON-RPC 2.0 request for the MCP endpoint.',
          required: ['jsonrpc', 'method'],
          properties: {
            jsonrpc: { type: 'string', enum: ['2.0'] },
            id: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
            method: { type: 'string', enum: ['initialize', 'tools/list', 'tools/call'] },
            params: { type: 'object' },
          },
        },
      },
    },
  };
}

function b(port: number): string {
  return `http://127.0.0.1:${port}`;
}
