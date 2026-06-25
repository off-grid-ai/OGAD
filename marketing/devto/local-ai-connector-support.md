---
title: "Connector Support in Off Grid AI Desktop: Private, Approval-Gated Integrations"
published: true
description: Connect Notion, Linear, Jira, and any MCP tool locally. The on-device model reasons over the data; every action goes through an approval queue.
tags: ai, privacy, mcp, productivity
cover_image: https://raw.githubusercontent.com/off-grid-ai/desktop/marketing-assets/covers/local-ai-connector-support.jpg
---

The Model Context Protocol lets an AI assistant talk to your tools through a standard interface, and the spec is open. Most products that adopt it still route your tool data through their cloud and let the model act on your behalf with no record. Off Grid AI Desktop runs MCP connectors locally: the connector fetches, the on-device model reasons, and every proposed action waits in an approval queue before anything happens.

**[GitHub →](https://github.com/off-grid-ai/desktop)** Free, open-source, runs offline.

## What a connector does here

A connector is a bridge between the local model and an outside tool. Off Grid AI Desktop speaks MCP over two transports: stdio for local processes and HTTP for remote servers. That covers most MCP servers in the wild.

You add a connector, enable it, and test it. The app discovers the tools that connector exposes. From then on, the on-device model can call those tools inside a normal chat.

Verified connectors today include Notion, Linear, and Jira/Confluence. The framework is general MCP, so it is not a fixed list of three. If a server speaks MCP over stdio or HTTP, you can wire it in.

## What you need

This runs on macOS and Windows.

| Tier | Hardware | What you get |
|---|---|---|
| Minimum | 16 GB RAM, 10 GB free disk | Connectors work; a small local model reads and summarizes fetched data |
| Recommended | 24 GB+ unified memory (Mac) or 8 GB+ GPU (NVIDIA/Vulkan) | A larger local model handles multi-tool chats and longer context |

Connectors themselves are cheap. The work sits with the local model that reads what they return.

## The privacy model: fetch, reason, approve

Three steps, and the boundary between them is the whole point.

**Fetch.** The connector pulls data from the outside tool. A Notion page, a list of Linear issues, a Jira ticket. That data comes into the app.

**Reason.** The local model reads it. This is the step that usually happens on a vendor's server. Here it happens on your machine. Your Notion contents and your issue tracker do not pass through a model we host, because we host no model. There isn't one.

**Approve.** When the model proposes an action that changes something (creating an issue, editing a page, posting a comment), the action does not run. It lands in an approval queue. You read what it wants to do, then approve or reject. Every approval is written to an audit log.

Nothing executes without a logged approval. The model can suggest all day. It cannot act until you say so, and you can see afterward exactly what ran and when.

<!-- GIF: model proposes "create Linear issue", action appears in the approval queue, user approves, audit log entry shows up -->

## How it works end to end

```text
outside tool (Notion / Linear / Jira)
        |
   connector (MCP: stdio or HTTP)  -- fetch
        |
   local model on your machine     -- reason
        |
   proposed action                 -- approval queue
        |
   you approve or reject           -- audit log
```

Read steps flow freely. The model can fetch and reason without bothering you. The gate is on writes. That is the line that keeps an autonomous loop from doing something you did not intend.

<!-- GIF: adding a connector, testing it, tools getting discovered, then asking the model a question that uses them -->

## Authentication without a central OAuth client

Most integration products make you authorize through their cloud OAuth app. That app becomes a standing key to your account, held by a third party.

Off Grid AI Desktop uses local-friendly auth instead. Connectors authenticate with Dynamic Client Registration over OAuth, or with a token you hold. There is no central OAuth client that we own sitting between you and your tools. The credential lives on your machine and is used from your machine.

So the connection is yours in both directions. The data comes to you, and the key that opens it stays with you.

## What you can do with it

- **Ask questions across your tools.** "What Linear issues are assigned to me this sprint, and which ones touch the billing service." The model fetches and reasons locally.
- **Draft changes and review them.** The model proposes a new ticket or a page edit. You approve it from the queue.
- **Keep a record.** The audit log shows every action that ran, so you can answer "what did this thing actually do" with a fact, not a guess.

<!-- GIF: a chat that reads from Notion and Jira in the same turn, then proposes one write action -->

Each of these turns a connector from a data pipe into a working assistant that still answers to you.

## A practical tip: scope connectors narrowly

Give each connector the smallest access that does the job. A read-mostly token on your issue tracker is enough for "summarize my open tickets." You do not need write access to ask questions.

When you do want the model to make changes, lean on the approval queue rather than pre-granting broad write scopes everywhere. The queue is the safety layer. Use it. Read each proposed action before you approve, especially the first few times you trust a new connector with writes.

## Privacy: stronger than a cloud integration platform

A cloud integration platform holds an OAuth key to your account, routes your tool data through its servers, and runs the model there too. Three points where your data sits on someone else's hardware.

Off Grid AI Desktop collapses all three onto your machine. The credential is local. The fetched data stays local. The model that reads it is local. The app is open source under AGPL-3.0, takes no account, and sends no telemetry. Connectors reach out to the tools you name and nowhere else.

## Getting started

1. Clone or download from GitHub: https://github.com/off-grid-ai/desktop
2. Install the app on macOS or Windows.
3. Open the connectors area and add a connector (stdio or HTTP), for example Notion, Linear, or Jira/Confluence.
4. Enable and test it. The app discovers the available tools.
5. Open a chat and ask a question that uses the connector. When the model proposes a write, approve it from the queue.

## What's coming

- More verified connectors on top of the general MCP support.
- Per-connector permission profiles so you can pin read-only vs write access per tool.
- Cross-device sync so a connector you set up on one machine is available on another, still without a cloud middleman.

## FAQ

### Q: Is it really free?

Yes. Off Grid AI Desktop is free and open source under AGPL-3.0. No account, no card.

### Q: What transports does it support?

MCP over stdio (local processes) and HTTP (remote servers). The framework is general MCP, not a fixed integration list.

### Q: Which connectors are verified?

Notion, Linear, and Jira/Confluence today. Because the support is general MCP, other servers that speak stdio or HTTP work too.

### Q: Does the model act on my behalf automatically?

No. Any action that changes something goes to an approval queue. Nothing executes without a logged approval, and the audit log records what ran.

### Q: Where does my tool data go?

Into the app on your machine. The connector fetches it, the local model reasons over it on-device, and it does not pass through a server we host.

### Q: How does auth work without a central OAuth app?

Connectors use Dynamic Client Registration over OAuth or a token you hold. There is no central OAuth client that we own. The credential stays on your machine.

Connect your tools, keep the keys and the data on your machine, and approve every action yourself. **[Off Grid AI Desktop on GitHub →](https://github.com/off-grid-ai/desktop)**
