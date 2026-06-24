# Off Grid Gateway — the spine

How the 5-layer agentic stack (`wednesdayai/knowledge-base/architecture.md`) maps onto
the local-first desktop gateway at `127.0.0.1:7878` (`src/main/model-server.ts`), and the
plan to grow that gateway from a request *router* into a control-plane *spine*.

References: Portkey OSS gateway (TS, plugin-based) and Bifrost (Go, high-perf) — what to
steal from each is called out below.

---

## Thesis

The knowledge base says it plainly: **Phase C (the AI gateway) is the spine — pick it
first, not last.** The other four phases are *wired through* the chokepoint, not *stuffed
into* one process.

So "build all of this in the gateway" resolves to two different moves:

1. **The gateway IS Phase C.** Audit, policy, identity, observability, kill switch,
   routing — these literally live in the gateway. Build them here.
2. **The gateway FRONTS Phases A/B/D.** Capture (A), KB/memory/tools (B), and the UI (D)
   stay where they are; the gateway is the single seam they pass through and the single
   place they're governed.

The mistake to avoid is collapsing all five layers into one Node module. The win is making
every LLM/tool/model call in the app — from the renderer, from CRM agents, from a paired
device, from a third-party SDK pointed at `:7878` — pass through one governed pipeline.

---

## The architectural change: router → middleware pipeline

Today `model-server.ts` is a clean OpenAI-compatible **multiplexer**: match URL → handler →
proxy to llama / whisper / TTS / diffusion / MCP. There are no cross-cutting hooks.

Both Portkey and Bifrost are built as a **middleware/plugin pipeline**, and that is the one
structural thing to adopt. Every request flows:

```
ingress
  → pre-hooks   (identity · budget · input policy: PII/injection scan)
  → route       (modality + model selection; local-first, optional cloud fallback)
  → post-hooks  (output policy: grounding/citation · egress DLP/redaction)
  → audit + observe   (trace the prompt, tools, model, tokens, latency)
  → response
```

Concretely: introduce a `Hook` type and a `pipeline()` wrapper around the existing
`serve()`/`proxyToLlama()` paths in `model-server.ts`. Hooks are ordered, each can
short-circuit (block, redact, rewrite) or annotate. This is Portkey's plugin model
expressed in-process. Keep it synchronous and cheap — this is loopback, not 5k RPS.

```ts
type HookResult = { action: 'pass' | 'block' | 'rewrite'; body?: unknown; reason?: string };
type Hook = (ctx: GatewayCtx) => Promise<HookResult> | HookResult;
// preHooks: identity, budget, inputPolicy
// postHooks: outputPolicy, egressDlp, audit
```

---

## What to steal from Portkey vs Bifrost

| | Portkey OSS | Bifrost |
|---|---|---|
| Language | **TypeScript** (matches our gateway) | Go (separate process) |
| Deploy | Node / edge / Docker, 122kb | NPX / Docker binary |
| Model | **Config-driven + `/plugins` middleware** | Plugin middleware, ~15µs overhead @ 5k RPS |
| Has | Guardrails (40+), fallbacks, retries, load-balance, semantic cache, virtual keys, **MCP gateway** | Virtual keys, hierarchical budgets, OIDC, semantic cache, **MCP gateway**, Prometheus |

- **Mirror Portkey's plugin/guardrail architecture in-process.** It's TypeScript like our
  gateway, the plugin shape (pre/post verifiers returning pass/block/transform) is exactly
  the pipeline above, and its MCP-gateway design (centralized auth + tool-call
  observability + identity forwarding) is the model for our `/mcp` endpoint. Don't vendor
  Portkey; copy the *shape*.
- **Treat Bifrost as the "externalize later" reference.** If the gateway ever leaves the
  Electron main process to become a standalone local daemon (shared by mobile/paired
  devices, or to stop blocking the event loop), Bifrost's Go architecture, weighted-key
  routing, and Prometheus surface are the blueprint. Not now — in-process TS is right while
  it's one user on one machine.
- **Semantic cache** from both is a free local win: cache embeddings of recent prompts,
  short-circuit near-duplicates. Cheap to add once the pipeline exists.

---

## The 5 layers, translated to local single-user

The BFSI model assumes multi-tenant, regulated, cloud. On a single-user local device most
of the multi-tenant/regulatory machinery **collapses** — but a surprising amount stays
**load-bearing**, often in a new guise. The privacy stakes are *higher*, not lower:
capture sees everything on screen.

| BFSI layer | In Off Grid | Verdict | Where it lives |
|---|---|---|---|
| **A · Data plane** (CDC, lake, PII mask) | capture → OCR → entities → SQLite | Exists | `watcher.ts`, `vision.ts`, `database.ts`, `crm/*` — gateway *consumes*, doesn't own |
| **A · PII masking** | redact before anything leaves the device | **Survives, critical** | post-hook egress DLP (see C16) |
| **B · Model serving** | llama / whisper / TTS / diffusion | Exists | gateway already fronts it |
| **B · KB + retrieval** | RAG extractors + embeddings | Promote | expose retrieval as a first-class gateway tool |
| **B · Memory (sidecar)** | observations / entities / memory | Promote | memory read/write through the gateway, not baked into one agent |
| **B · Tool layer (MCP)** | `/mcp` endpoint | Exists, extend | per-tool scope + audit, Portkey-style |
| **C · Gateway** | `:7878` | **This whole doc** | `model-server.ts` |
| **C · Audit log** | every chat/tool/model call recorded | **Survives, high value** | new SQLite table; "what did my AI see and do" is a *feature* of a memory product |
| **C · Input policy** | injection scan of captured/retrieved text | **Survives** — captured screen text is hostile indirect-injection input | pre-hook |
| **C · Output/DLP** | gate egress to cloud fallback / outbound MCP / paired device | **Survives, critical** | post-hook; the privacy guarantee of the product |
| **C · Kill switch** | "stop all AI / pause capture now" | **Survives** | pipeline flag + tray |
| **C · Observability** | tokens, latency, per-feature traces | **Survives** | local dashboard off the audit stream |
| **C · Identity / RBAC** | single user | Collapses now, **re-emerges for paired devices** | per-device token (gateway already anticipates "a paired device later") |
| **C · FinOps** | compute/battery budget; $ only if cloud fallback added | Mostly collapses | budget pre-hook, optional |
| **D · Consumption** | React UI + approval-gated actions | Exists | `crm/approvals.ts`; gateway feeds it traces/citations/confidence |
| **E · Org / regulatory** | local-first guarantee, recording indicator, user-owned data, AGPL | Collapses to product posture | not gateway code; "AIBOM" → a manifest of bundled models |

**The three that matter most locally:** audit log (C7), input policy against indirect
injection from captured content (C2), and egress DLP (C16). Those are the spine's
load-bearing beams for a privacy product. Routing/fallback (C1) matters only once you add a
cloud model option.

---

## Build sequence

Staged like the knowledge base's path — each stage earns the next. Don't build Stage 3
machinery before the pipeline exists.

### Stage 1 — Make it a pipeline (the unlock)
- Add `Hook` type + `pipeline()` around `serve()` / `proxyToLlama()`.
- Add the **audit log**: one SQLite table, every request (prompt, modality, model, tokens,
  latency, tool calls, outcome). Start logging before any policy exists — it's the
  evidence stream everything else reads from.
- Add the **kill switch**: a single pipeline flag, wired to the tray.
- *Done when:* every call through `:7878` produces an audit row and can be halted instantly.

### Stage 2 — Policy (the privacy beams)
- **Input pre-hook:** Presidio-style PII tag + prompt-injection heuristics, run especially
  over *retrieved/captured* content, not just the user prompt. Treat screen text as
  hostile.
- **Egress post-hook (DLP):** before any byte leaves the device — cloud model fallback,
  outbound MCP tool call, paired-device sync — redact/block per policy. This is *the*
  privacy guarantee; make it the one hook that cannot be bypassed.
- *Done when:* nothing leaves the device unredacted, and injected instructions in captured
  content are caught.

### Stage 3 — Consolidate Phase B through the gateway
- Promote **RAG retrieval** and **memory read/write** to first-class gateway tools/endpoints
  (today they're libraries the renderer calls directly).
- Extend **`/mcp`** with per-tool scope + audit (Portkey MCP-gateway shape).
- Add **semantic cache** (embed prompt, short-circuit near-duplicates).
- *Done when:* CRM agents and the renderer reach memory/KB/tools *through* the gateway, so
  every reach is audited and policy-checked.

### Stage 4 — Observability + routing
- **Local dashboard** off the audit stream: tokens, latency, per-feature traces, "why this
  answer" + citations into the UI (D3b trust indicators).
- **Routing/fallback** (Portkey/Bifrost): local-first, optional cloud (Claude) fallback for
  hard reasoning — and *that* call goes through the egress DLP hook by construction.
- *Done when:* you can replay any single answer's full trace, and cloud fallback is
  governed, not a side channel.

### Stage 5 — Paired-device identity
- Per-device token issuance (C4 re-emerges). The gateway already says "a paired device
  later" in its header comment — this is where RBAC stops being a no-op.

---

## The one rule

Every model call, tool call, memory read, and outbound byte goes through `:7878`. The
moment a feature reaches a model or leaves the device *around* the gateway, the spine stops
reading true — exactly the knowledge base's warning about shadow AI. One chokepoint, no
exceptions.
