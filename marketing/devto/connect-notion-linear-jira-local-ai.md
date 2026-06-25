---
title: How to Connect Notion, Linear, and Jira to a Local AI (Private MCP)
published: false
description: Connect Notion, Linear, and Jira to an on-device model that reasons over your data, with every action approval-gated and logged.
tags: ai, privacy, mcp, productivity
cover_image:
---

Your laptop has a GPU and 16GB of RAM that mostly idle while you tab between Notion, Linear, and Jira copying context by hand. A cloud AI assistant could connect those tools, but it routes your tickets and docs through a server you do not own and bills you every month. Off Grid AI Desktop is a free, open-source app that connects those same tools to a model running directly on your Mac or PC.

**[GitHub](https://github.com/off-grid-ai/desktop)**

Free, open-source, runs offline.

## What this gets you

You connect Notion, Linear, Jira, or Confluence through MCP connectors. The local model reads what those tools return and reasons over it. When the model wants to do something, create an issue, update a page, it does not just act. The action lands in an approval queue and waits for you.

So you get an assistant that can see your work tools and propose changes, without handing the keys to a server, and without anything happening behind your back.

## What is MCP

MCP is the Model Context Protocol. It is a standard way for an AI model to talk to outside tools through small connector programs.

The connector knows how to fetch from one service, your Notion pages, your Linear issues, your Jira board. The model asks the connector for data, the connector returns it, and the model reasons over the result. The data lands on your machine and the reasoning happens on your machine.

This is the split that matters. Connectors fetch. The local model reasons. Your data stays on the device.

## What You Need

The connectors are light. The model is the heavy part, and it runs locally.

| Tier | Chip / GPU | RAM | OS | Free disk |
|---|---|---|---|---|
| Minimum | Apple Silicon M1, or any 2019+ Intel/AMD with iGPU | 8GB | macOS 13+, Windows 11 | 10GB |
| Recommended | M2/M3/M4, or NVIDIA RTX (CUDA) | 16GB+ | macOS 14+, Windows 11 | 20GB+ |

You also need the API token or login for each service you connect, the same credential you would use for any integration.

## What Off Grid AI Desktop Can Do

You can connect tools like Notion, Linear, and Jira or Confluence. Once connected, you ask the model questions that span them. "Summarize the open Linear issues tagged urgent and draft a Notion update." The model fetches through the connectors and reasons over the combined data.

Every action is approval-gated. The model can read freely, but anything that changes data, a new issue, an edited page, a status change, goes into an approval queue. Nothing acts without your sign-off.

The app keeps an audit log. Every approved action is recorded, so you can see exactly what ran, when, and against which tool. There is no acting without a logged approval.

## How the Approval Queue Works

The flow has three steps, and the middle one is yours.

First, the model proposes. It reads your request, fetches what it needs through the connectors, and decides on an action. For a read, it just answers. For a write, it builds the action and stops.

Second, you review. The proposed action sits in the queue with its full detail: which tool, which object, what changes. You approve it or you reject it.

Third, the app executes and logs. Only after your approval does the connector run the action against the service. The audit log records it.

This is the opposite of an agent that fires off changes and tells you afterward. The model never touches your Jira board or your Notion workspace without a logged approval first.

## How Hardware Acceleration Works

The model runs on the bundled `llama.cpp` server. On a Mac it uses Metal and unified memory, so a quantized model shares one memory pool across CPU and GPU and runs at usable speed on M-series chips.

On Windows it uses CUDA on NVIDIA cards or Vulkan elsewhere, with a CPU fallback for smaller models. Models ship as quantized GGUF files, a q8_0 or Q4_K build fits in consumer RAM and VRAM instead of needing server hardware.

The connectors themselves barely register. They make network calls to the services you connected and hand the results to the model. The reasoning is the only expensive part, and it stays local.

## Getting the Most From Connectors

A few habits keep this useful and safe.

Scope your tokens. Give each connector the narrowest access that does the job. If the model only needs to read a Linear project, do not hand it write access to the whole workspace.

Read the action before you approve it. The queue exists so you can catch a wrong edit before it happens. Skim the diff, confirm the target object, then approve.

Keep requests concrete. "Update the page" is vague and the model may propose the wrong change. "Add a status section to the Q3 roadmap page summarizing the three open epics" gives it a target the queue can show you clearly.

Check the audit log periodically. It is your record of what the assistant has done across your tools, useful for both trust and for retracing your own steps.

## Privacy: Stronger Than a Cloud Assistant

A cloud AI assistant that connects your work tools sends your tickets, docs, and board data to a server to be reasoned over. The vendor sees your roadmap. You trust their retention policy and their access controls.

Off Grid AI Desktop keeps the reasoning local. The connectors pull data to your machine, the on-device model reasons over it, and nothing routes through a server we own. No account, no telemetry. The code is AGPL-3.0, so you can verify what each connector sends and where.

You still send credentials to the third-party services you connect, that is unavoidable for any integration. What changes is that the AI layer sits on your hardware, not someone else's.

## Getting Started

1. Go to [github.com/off-grid-ai/desktop](https://github.com/off-grid-ai/desktop) and download the macOS or Windows build, or clone and build from source.
2. Install and open the app. No account screen, because there is no account.
3. Open the Models browser, download a chat model that fits your RAM.
4. Open connector settings and add Notion, Linear, or Jira with its token.
5. Ask the model a question across your tools, then review and approve any action it proposes.

## What's Coming

- More connectors beyond the current set.
- Cross-device sync, so an approval queue on your laptop reflects on your other machines without a server in the middle.
- Richer audit views for teams that need a clear history of what ran.

## FAQ

### Q: Is it really free?

Yes. The app is free and open-source under AGPL-3.0. The connectors and the approval queue are part of the free core.

### Q: Can the AI change my data without asking?

No. Reads are free, but every write goes through the approval queue and into the audit log. Nothing acts without a logged approval.

### Q: Which tools can I connect?

Connectors for tools like Notion, Linear, and Jira or Confluence. The connector set grows over time.

### Q: Does my data go to a server?

The reasoning runs on-device and does not route through a server we own. The connectors do call the third-party services you connect, since that is where your data lives.

### Q: Does it run on both Windows and Mac?

Yes. Macs use Metal, Windows uses CUDA or Vulkan with a CPU fallback.

### Q: How much RAM do I need?

8GB runs a small model. 16GB or more is comfortable for larger models and heavier reasoning.

Download it and put a private AI in front of your work tools.

**[GitHub](https://github.com/off-grid-ai/desktop)**
