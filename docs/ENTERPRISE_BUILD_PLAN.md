# Off Grid for Organizations — full build plan

This plan **inherits the entire 5-plane agentic architecture** from the stack navigator
(`wednesdayai/knowledge-base/agentic-ai-stack-navigator.md` = the canonical text of
`cro/proposals/final/agentic-ai-stack-navigator.html`). Every component A1→E6, plus the
Physical plane, is accounted for below and mapped to Off Grid.

The navigator was written for a multi-tenant regulated bank on cloud/on-prem. Off Grid is
**local-first, on-device, single-org-per-deployment, on-prem.** That changes _how_ each
layer is realized, not _whether_ it exists. Six rules drive every mapping:

1. **The work is the data source.** The "data plane" is capture (screen / messages / calls
   on org time) + optional connectors — not a cloud data lake.
2. **The substrate is distributed.** Data lands per-device (SQLite) plus a thin org **Brain**
   that holds only distilled knowledge — not one central lake.
3. **The AI plane came first.** On a laptop there's no model serving unless we build it, so
   we built it first (`model-server.ts`). The control plane _wraps_ the AI plane we already
   have — the inverse of the bank's "gateway first" order.
4. **Worker owns raw; org sees distilled.** Raw capture never leaves the worker's device by
   default. Only distilled SOPs/patterns go up. This is the access-control spine **and** the
   ethical line. Architectural, not a policy promise.
5. **Egress control is the load-bearing control.** The gateway decides what may leave the
   device (to a cloud model, a connector, another device). This is the privacy guarantee.
6. **Provenance = "where was this observed."** Every SOP and answer cites the captured source
   it came from. Grounding is a link back to a real observation.

---

## The vision

**One common control plane for every piece of AI in the organization.** Every model call,
every agent action, every byte of org data, every cloud route — all pass through the same
governed chokepoint, on the org's own infrastructure, fully auditable. That is the whole
vision, and on that axis we compete directly with the auditable-enterprise-AI players
(Pints.ai and the like) — same promise: AI a regulator can defend, deployed on your infra,
data never leaves your control.

**But the wedge is different, and it's ours.** Those players sell top-down into compliance,
back-office, document workflows. We land **bottom-up through a frontline/sales-productivity
tool people actually want** — the on-device node that helps the worker _and_ observes the
work. The control plane rides in _with_ the node. So we don't have to win a 12-month
compliance procurement to get installed; the productivity tool gets us in, and the common
control plane is what we already are once we're there. The frontline use case is the
distribution mechanism for the control-plane vision — not a separate bet.

---

## The six products (who owns what)

| Product                                   | Role                                                                                                                                                                                                                                                                                               | In navigator terms                                    |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Personal AI** (Desktop + Mobile)        | Each person's private copilot, memory, and capture. The worker's benefit.                                                                                                                                                                                                                          | Consumption (D) + local Data (A) + local AI plane (B) |
| **Gateway** (`:7878`, per device)         | Routes every model/tool call. Controls egress. Logs everything.                                                                                                                                                                                                                                    | Control plane (C) + AI-plane serving (B15/B7)         |
| **Brain** (org)                           | The distilled org knowledge — SOPs, patterns, "what good is." Serves it back.                                                                                                                                                                                                                      | AI-plane substrate (B3/B5a/B11) + Data landing (A10)  |
| **Fleet Control** (on-prem admin **app**) | **MDM for AI.** Connects to the fleet of nodes. Enrolls them, provisions policy + knowledge + intelligence config down, pulls audit + telemetry + distilled learnings up, renders the DPO/compliance view. Does **not** run the intelligence or enforce policy itself — the nodes do. Never cloud. | Control plane (C) _define/observe_ + Regulatory (E)   |
| **Sync** (EasyShare)                      | Desktop ↔ mobile, device ↔ org transport.                                                                                                                                                                                                                                                          | cross-cutting transport                               |
| **Learning loop** (batch)                 | Observe → find patterns → write SOPs → grade quality.                                                                                                                                                                                                                                              | Consumption flywheel (D8) + AI orchestration (D1)     |

---

## Node vs Fleet Control — the MDM split

The node (Desktop/Mobile) is **self-contained and self-governing**. It carries the gateway,
the personal AI, capture, the learning loop, and **enforces its own policy — even offline.**
Fleet Control is the **app that connects to the fleet** to define and observe; it does not
run the intelligence or enforce policy itself. Every control has two halves:

| Control                     | Node — _enforce / emit_                      | Fleet Control — _define / observe_                            |
| --------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| Gateway (C1)                | routes & runs locally                        | —                                                             |
| Input/output policy (C2/C3) | enforces locally                             | authors the rules                                             |
| Egress gate (C16)           | blocks/redacts on-device                     | sets what's allowed out                                       |
| Audit (C7)                  | writes every call locally                    | aggregates + DPO view + export (E1/E6)                        |
| Observability (C8)          | emits traces                                 | fleet dashboards                                              |
| RBAC (C5)                   | enforces on-device                           | authors who-sees-what                                         |
| Identity (C4)               | holds its device token                       | issues tokens, enrolls devices                                |
| Kill switch (C9c)           | executes the halt                            | triggers it across the fleet                                  |
| Eval / drift (C9/C9a)       | runs local checks                            | fleet-wide gates + rollup                                     |
| Intelligence config         | runs the SOPs / models / agents it was given | **provisions which intelligence each role gets** (from Brain) |

**Fleet Control pushes down:** policy + knowledge (from Brain) + intelligence config.
**Fleet Control pulls up:** audit + telemetry + distilled learnings.
Enforcement is node-local by design — a node governs itself with or without a live link.

## Two ingestion paths into Brain

The system **doubles as both** a work-observation layer and an org-data ingestion layer. Two
sources feed Brain, so the intelligence baked into nodes is grounded in **what people do
_and_ the org's real data** — not observation alone:

1. **Observed work (push, from nodes).** Capture on org time → distilled learnings flow _up_
   from devices. Worker-owns-raw; only the distilled layer leaves the device. _(A1 capture.)_
2. **Org digital data (pull, via connectors).** An **org-side ingest service** pulls from
   databases, warehouses, SaaS, and document stores → ETL → PII mask → index into Brain.
   This is org-owned data by definition; access is governed by A11/C5. Runs next to Brain on
   the org's infra (warehouses are org infra), behind the same policy. _(A1 connectors, A3
   CDC, A3a contracts, A7/A9 mask.)_

```
 Org systems (DBs · warehouses · SaaS · docs)         Nodes (Desktop / Mobile)
        │  pull · ETL · mask · index                        │  capture → distill (push)
        ▼                                                    ▼
                          BRAIN  (org knowledge: data + observed work)
                            │ SOPs / patterns / "what good is" + intelligence config
                            ▼
                     FLEET CONTROL  ── provisions down · observes up ──►  every node
```

---

## Phase A — DATA PLANE

> Bank version: get data out of source systems, prep, govern, land. Off Grid version: the
> work itself is the source; it lands on-device and (distilled) in Brain.

| #    | Navigator component            | Off Grid realization                                                                                                                                                                                                                | Owner                                       | Status                                                                                                |
| ---- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| A1   | Source systems                 | **Two first-class sources.** (1) **Capture** (screen→OCR, messages, calls) — the work itself, on the node. (2) **Org digital data** — databases, warehouses, SaaS, document stores — via connectors on the org-side ingest service. | Personal AI capture · Brain-side connectors | ✅ capture (`watcher.ts`, `vision.ts`, `ocr.swift`, meeting recorder); ❌ enterprise connectors build |
| A3   | CDC / ingestion                | Node: continuous on-device ingest of capture. Org: CDC/connector pulls from DBs & warehouses → ETL → mask → Brain.                                                                                                                  | Personal AI ingest · Brain ingest service   | ✅ `watcher.ts`, `ingest.ts`; ❌ org ingest service                                                   |
| A3a  | Schema registry / contracts    | The observation/entity schema — stable contract for what capture emits.                                                                                                                                                             | Brain · ingest                              | ✅ `crm/schema.ts`                                                                                    |
| A5   | Data catalog                   | Index of what's known — entities, sources, where each came from.                                                                                                                                                                    | Brain                                       | ⚠️ partial (`EntityGraph`, `database.ts`)                                                             |
| A7   | PII discovery + classification | Detect & tag PII in captured content. **Critical** — capture sees everything on screen. On-device (Presidio-class).                                                                                                                 | Gateway input policy · ingest               | ❌ build                                                                                              |
| A7a  | Consent management             | Per-device, per-purpose opt-in; the **"on org time" boundary**; visible recording indicator.                                                                                                                                        | Fleet Control policy · Personal AI          | ⚠️ consumer opt-in pattern exists; org policy build                                                   |
| A9   | PII masking + synthetic        | Redact PII **before anything leaves the device**. Same engine the egress gate uses.                                                                                                                                                 | Gateway egress (C16)                        | ❌ build                                                                                              |
| A10  | Data lake (zones)              | No cloud lake. **Per-device SQLite** (raw, stays local) + **Brain** (distilled, org-shared). The zone boundary is the device edge.                                                                                                  | Personal AI · Brain                         | ✅ SQLite; ❌ Brain build                                                                             |
| A11  | Fine-grained access            | Who in the org sees which distilled knowledge. Enforces **worker-owns-raw / org-sees-distilled**.                                                                                                                                   | Fleet Control · Brain                       | ❌ build                                                                                              |
| A12a | Retention + erasure            | "Delete this person" across device + Brain + memory. File-based markdown memory makes erasure `git revert`, not a vector rebuild (navigator's own note).                                                                            | Fleet Control · Brain                       | ❌ build                                                                                              |

---

## Phase B — AI PLANE

> The engine. This is largely **already built** — it's what `model-server.ts` is.

| #   | Navigator component         | Off Grid realization                                                                                                                           | Owner                         | Status                                        |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------- |
| B1  | Doc parsing + chunking      | OCR + audio transcription + doc extractors.                                                                                                    | Gateway (AI plane)            | ✅ `rag/extractors`, whisper, vision          |
| B2a | Reranking + hybrid search   | Retrieval over captured + Brain content; BM25 + vector + rerank.                                                                               | Gateway                       | ⚠️ embeddings exist; hybrid + rerank build    |
| B3  | Vector store / KB index     | On-device index (personal) + Brain index (org).                                                                                                | Personal AI · Brain           | ⚠️ embeddings + SQLite; dedicated index build |
| B5a | Provenance + citation       | **Every SOP/answer traces to the captured source** (which screen, which call, when). The auditability beam. _(This is the "SANN-equivalent.")_ | Brain · Gateway output policy | ❌ build                                      |
| B7  | Tool layer (MCP)            | `/mcp` — on-device models + actions + org connectors as scoped, audited tools.                                                                 | Gateway                       | ✅ `mcp-server.ts`, extend with scope+audit   |
| B9  | Sandboxed code execution    | Agents run untrusted code in isolation (microVM), never the host.                                                                              | Gateway                       | ❌ build (later)                              |
| B11 | Memory (sidecar, 4 flavors) | Exactly Off Grid's memory: short-term, long-term vector, entity graph, file-based markdown. **Personal memory** + **org memory (Brain)**.      | Personal AI · Brain           | ✅ strong (`crm/*`, observations, memory)     |
| B15 | Model serving / inference   | Bundled llama-server, whisper, TTS, diffusion — unified at `:7878`.                                                                            | Gateway                       | ✅ strong (`model-server.ts`)                 |
| B16 | Fine-tuning + privacy ML    | Adapt the local SLM to the org's domain & SOPs (LoRA), on-device or in Brain.                                                                  | Brain                         | ❌ build (later)                              |

---

## Phase C — CONTROL PLANE

> The gateway spine. Wraps the AI plane we already have. **This is the bulk of the new
> build**, and where Fleet Control plugs in.

| #   | Navigator component          | Off Grid realization                                                                                              | Owner                   | Status                                       |
| --- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------- |
| C1  | AI gateway                   | `:7878` becomes a real chokepoint: routing local + **leashed cloud** (rule 5).                                    | Gateway                 | ⚠️ started — single local model, add routing |
| C2  | Input policy / guardrails    | Injection scan — **especially of captured content** (hostile indirect input).                                     | Gateway pre-hook        | ❌ build                                     |
| C3  | Output policy + grounding    | No ungrounded SOP ships — must cite a real observation (B5a) or it's blocked/flagged.                             | Gateway post-hook       | ❌ build                                     |
| C4  | Identity + token issuance    | Per-device identity (collapses for one user, **re-emerges for the fleet**).                                       | Fleet Control           | ❌ build                                     |
| C5  | RBAC / ABAC                  | Who sees which distilled knowledge; **enforces worker-owns-raw** (rule 4).                                        | Fleet Control · Gateway | ❌ build                                     |
| C7  | Audit log + lineage          | Every model/tool call + **what left the device**. The DPO's single evidence stream.                               | Gateway → Fleet Control | ❌ build — **START HERE**                    |
| C8  | Observability + tracing      | Tokens, latency, full trace per person/feature; replay any answer.                                                | Gateway → Fleet Control | ❌ build                                     |
| C9  | Eval + red teaming           | Quality gate on the local model **and** on SOP quality. Drift checks.                                             | Fleet Control · Brain   | ❌ build                                     |
| C9a | Bias + fairness              | For consequential frontline decisions.                                                                            | Fleet Control           | ❌ build (later)                             |
| C9c | Incident response + runbooks | **Kill switch** ("stop all AI / pause capture") + runbooks.                                                       | Fleet Control           | ❌ build — kill switch early                 |
| C14 | FinOps + cost                | Per-device compute/battery budget; $ only matters once cloud fallback is on.                                      | Fleet Control           | ❌ build (light)                             |
| C16 | DLP + exfil prevention       | **The egress gate** — what may leave to a cloud model / connector / other device. The privacy guarantee (rule 5). | Gateway                 | ❌ build — **START HERE**                    |
| C21 | Durable execution            | Long agent runs (a batch SOP-mining job over a week of capture) resume, not restart.                              | Gateway / runtime       | ❌ build (later)                             |

---

## Phase D — CONSUMPTION

> Where humans meet it. Mostly **already built** on the Personal AI side.

| #   | Navigator component            | Off Grid realization                                                          | Owner                       | Status                                  |
| --- | ------------------------------ | ----------------------------------------------------------------------------- | --------------------------- | --------------------------------------- |
| D1  | Agent runtime / orchestration  | The agents that do the work + the **learning-loop batch jobs** (observe→SOP). | Personal AI · Brain         | ⚠️ partial (`crm/agent.ts`); loop build |
| D2  | Human-in-the-loop              | Approval-gated actions on anything consequential.                             | Personal AI                 | ✅ `crm/approvals.ts`                   |
| D3  | Conversational + generative UI | The copilot UI, desktop-first.                                                | Personal AI                 | ✅ React app                            |
| D3b | Trust indicators               | Citation chips — **"why this SOP / where it was observed"**, confidence.      | Personal AI · Fleet Control | ❌ build                                |
| D4  | Voice + telephony              | Capture & understand calls (your explicit ask — phone, meetings).             | Personal AI capture         | ⚠️ meeting recorder + whisper; extend   |
| D8  | Feedback + data flywheel       | Thumbs/corrections on SOPs feed eval + Brain. Start day one.                  | Personal AI → Brain         | ❌ build                                |

---

## Phase E — ORG + REGULATORY

> Functions, not just tools. Realized mostly inside **Fleet Control** (the DPO's product).

| #   | Navigator component   | Off Grid realization                                                                   | Owner                    | Status   |
| --- | --------------------- | -------------------------------------------------------------------------------------- | ------------------------ | -------- |
| E1  | Framework mapping     | Map controls → DPDP/etc clauses. **The DPO single compliant view + one-click export.** | Fleet Control            | ❌ build |
| E2  | AI use policy         | What staff may do; authored and **pushed to every device** by Fleet Control.           | Fleet Control            | ❌ build |
| E5  | Ethics / review board | Process; supported by Fleet Control's audit + eval evidence.                           | Fleet Control (workflow) | process  |
| E6  | DPIA / FRIA           | Per use case; Fleet Control **generates the assessment pack** from the audit stream.   | Fleet Control            | ❌ build |

---

## Phase 0 — PHYSICAL PLANE

| Navigator                  | Off Grid realization                                                                                                                                           | Status     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| GPUs / nodes / power / K8s | The **devices themselves** (laptops, phones) run inference on-device. Optional **on-prem org server** hosts Fleet Control + Brain. No hyperscaler in the path. | deployment |

---

## Build stages (navigator Path, localized)

The navigator's "pick the gateway first" inverts for us — the AI plane (B) is already live,
so Stage 1 is **wrapping it with control (C7 + C16)**, then standing up Fleet Control.

- **Stage 1 — Control the chokepoint.** C1 routing · **C7 audit log** · **C16 egress gate** ·
  C9c kill switch. Pre/post hook pipeline in `model-server.ts`. _Done when every call is
  logged and nothing leaves the device unless policy allows._
- **Stage 2 — Fleet Control foundation.** C4 identity · enroll a device · push policy (E2)
  down · pull audit (C7) up · the DPO view (E1) v0. On-prem. _Done when an admin can govern
  a device from one console._
- **Stage 3 — The learning loop.** D1 batch orchestration · A7/A9 PII tag+mask on ingest ·
  B5a provenance · SOP/pattern synthesis (D8 flywheel). _Done when the system writes a cited
  SOP from a week of observed work._
- **Stage 4 — Brain.** B3 org index · A10 distilled store · A11/C5 access control · push SOPs
  back to every device (D3b trust indicators at point of work). _Done when "what good is"
  flows back to everyone, worker-owns-raw enforced._
- **Stage 5 — Hardening.** C8 observability · C9/C9a eval+bias gates · C21 durable runs ·
  A12a erasure · E6 DPIA packs · Sync at org scale · mobile parity.

---

## Where I'd start (Stage 1, first commit)

In `model-server.ts`, the change everything else hangs on:

1. **Pre/post hook pipeline** around `serve()` / `proxyToLlama()` — gives policy + logging a
   home (C1).
2. **Audit log** (SQLite) — one row per call: who · model · tokens · tools · **what left the
   device** (C7).
3. **Egress gate** — the single rule deciding whether a payload may reach a cloud model /
   connector, with PII redaction (C16 + A9) on the way out.

That turns the router into the controlled chokepoint Fleet Control manages in Stage 2.
