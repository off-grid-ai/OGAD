---
title: How to Expose On-Device AI Models as MCP Tools (Local MCP Server, No Cloud)
published: false
description: Turn your local chat, vision, image, speech, and embedding models into MCP tools any client can call, fully offline and on-device.
tags: ai, privacy, mcp, opensource
cover_image:
---

Your laptop can run a chat model, a vision model, a diffusion model, and a transcriber on its own GPU. Most setups still route every tool call through a cloud model that bills per token and reads everything you send. Off Grid AI Desktop is a free, open-source app that runs those models on your Mac or PC and serves them to any MCP client through a local MCP endpoint.

**[GitHub ->](https://github.com/off-grid-ai/desktop)**

Free, open-source (AGPL-3.0), runs offline.

## What MCP is, in two paragraphs

The Model Context Protocol is a standard way for an AI client to call external capabilities. A client lists the tools a server offers, then invokes them with structured arguments and reads structured results. It is JSON-RPC underneath. The point is that any compliant client can use any compliant server without custom glue.

Most MCP servers wrap a SaaS API: a Notion server, a GitHub server, a database server. The tool runs somewhere remote and the data travels there. Off Grid AI Desktop does the opposite. It wraps your own on-device models as MCP tools. The capability and the data both stay on your machine.

## The short version

Off Grid AI Desktop serves MCP at `http://127.0.0.1:7878/mcp`. It is Streamable HTTP, stateless JSON-RPC. The local chat, vision, image, speech, and embedding models show up as MCP tools. An MCP client connects, lists those tools, and calls them. Every call runs on-device. Nothing routes through a server anyone else owns.

## What you need

The app bundles the inference engines, so the requirement is hardware to run the models.

| Tier | Mac | Windows | RAM/VRAM | Disk |
|---|---|---|---|---|
| Minimum | Apple Silicon M1 | NVIDIA GPU or modern CPU | 16 GB | 20 GB free |
| Recommended | M3 / M4 | RTX with 8 GB+ VRAM | 32 GB | 40 GB+ free |

Models are quantized GGUF that fit consumer memory. Mac uses Metal over unified memory. Windows uses CUDA or Vulkan, with CPU fallback.

## How it works

The same app exposes an OpenAI-compatible HTTP API at `http://127.0.0.1:7878/v1` and an MCP endpoint at `http://127.0.0.1:7878/mcp`. The HTTP API is for code that already speaks OpenAI. The MCP endpoint is for clients that speak MCP and want to treat your local models as tools inside a larger agent loop.

Both bind to loopback only. The server answers your own machine. There is no key, no account, no cloud hop.

## Step 1: List the tools

MCP starts with a `tools/list` call. The server returns the local models as callable tools. Here is the raw JSON-RPC over the Streamable HTTP endpoint.

```bash
curl http://127.0.0.1:7878/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/list"
  }'
```

You get back a list of tools backed by your on-device models: chat, vision, image generation, speech, and embeddings. The endpoint is stateless, so each request stands alone. There is no session to keep open.

## Step 2: Call a tool

A `tools/call` invokes one tool by name with arguments. This calls the local chat model as an MCP tool.

```bash
curl http://127.0.0.1:7878/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "chat",
      "arguments": {
        "messages": [
          {"role": "user", "content": "Draft a one-line commit message for a README fix."}
        ]
      }
    }
  }'
```

The model runs on your GPU and returns the result through the MCP envelope. Swap the tool name and arguments to call vision, image generation, speech, or embeddings the same way.

## Step 3: Point a client at it

Most MCP clients take a server URL in their config. Add the local endpoint as an HTTP MCP server.

```json
{
  "mcpServers": {
    "offgrid-local": {
      "url": "http://127.0.0.1:7878/mcp"
    }
  }
}
```

Reload the client. The local models appear in its tool list. Now an agent running in that client can transcribe a file, describe an image, or generate one, and the work happens on your hardware.

## Why route models through MCP at all

You can already hit the models over the HTTP API. MCP buys you something different. It lets a client that orchestrates many tools treat your private models as just more tools in the same loop. A planning agent can call a remote tool for one step and your local vision model for the next, through one protocol, with one tool list.

That keeps the sensitive steps local. The image you do not want to upload gets described by the on-device vision tool. The audio you do not want to send out gets transcribed by the on-device speech tool. The agent never has to leave the machine for those calls.

## How the models share your memory

The app does not load every model at once. Each modality loads when its tool is called and offloads after. The chat model and the diffusion model never sit in RAM together. A 16 GB machine can back all the tools, one call at a time, without running out of memory.

Repeated calls to the same tool keep that model warm. A cold call pays a short load cost. For long-running tools like image generation, the underlying API supports async with a poll URL, so a slow render does not block.

## Privacy: stronger than a hosted tool server

A hosted MCP server sees every argument you pass and every result it returns. It needs credentials and it logs traffic. The Off Grid AI Desktop MCP endpoint binds to `127.0.0.1`, so it answers only your machine. There is no telemetry, no account, no key. The code is AGPL-3.0, so the behavior is auditable. Your prompts, images, and recordings stay on disk.

## Getting started

1. Download or clone from [github.com/off-grid-ai/desktop](https://github.com/off-grid-ai/desktop).
2. Install and launch the app.
3. Download a model for each modality you want to expose as a tool.
4. The MCP endpoint is live at `http://127.0.0.1:7878/mcp`. Run `tools/list` to confirm.
5. Add the URL to your MCP client config and reload.

The interactive HTTP docs at `/docs` and the spec at `/openapi.json` cover the companion `/v1` API if you want both surfaces.

## What's coming

- Reach the MCP endpoint from other paired devices over your local mesh, so a phone or tablet can use your desktop's models as tools. Local only, no cloud.
- More bundled models behind the tools.
- Broader tool coverage as the on-device modalities grow.

## FAQ

### Q: Is it really free?

Yes. Free and open-source under AGPL-3.0. The MCP endpoint is part of the open core.

### Q: Does it work offline?

Yes. Once models are downloaded, every tool call runs on-device with no network.

### Q: Which MCP clients work?

Any client that supports an HTTP MCP server over Streamable HTTP. Point it at the URL and it lists the tools.

### Q: Do I need an API key or account?

No. The endpoint checks neither. It is local-only by design.

### Q: Can another machine reach my MCP endpoint?

Not today. It binds to loopback. Cross-device access over the local mesh is a separate, future feature.

### Q: What models back the tools?

The same on-device models the app runs for chat, vision, image generation, speech, and embeddings. Run `GET /v1/models` to see which is active per modality.

Give your agent local tools that never phone home.

**[GitHub ->](https://github.com/off-grid-ai/desktop)**
