# Off Grid — Master Plan

The single forward plan for the enterprise product. Ties together `CONSOLE_PLAN.md`,
`ENTERPRISE_BUILD_PLAN.md`, `LICENSES.md` (in `off-grid-ai/console`), and everything decided
so far. Read this first; the others hold detail.

---

## 1. What we're building

A **common control plane for organizational AI**: one governed chokepoint for every model
call, agent action, and byte of data — running on the org's own infrastructure, fully
auditable, built on open source. It manages a **fleet of on-device nodes** (Off Grid
Desktop/Mobile), grounds them in the **organizational brain**, and proves compliance to a
regulator.

**Two halves, one story:**

- **Frontline value** — a private, on-device copilot for every worker; democratize the best
  people's know-how to the whole field force (sales productivity, frontline enablement).
- **Enterprise control** — the auditable, on-prem control plane a DPO/CISO can defend.

The frontline tool is the wedge (bottom-up adoption); the control plane is the payload. This
is how we land where the top-down compliance vendors (e.g. Pints) can't reach.

## 2. Positioning & packaging

- **On-prem, local-first, auditable.** Data never leaves the org's control.
- **Modular / à-la-carte.** Nine planes; buy any one standalone, any combination, or all.
  Every capability is API-first — "API only," "API + console," "just the Brain," or the whole
  plane.
- **Dual-license:** AGPL-3.0 edition **and** a commercial edition. Any module may be
  closed-source (see §7).
- **Single interface — ours.** One console, one login, one nav. Underlying OSS is never
  rebranded or surfaced as its own product.

## 3. The nine planes (and the 5-layer reference mapping)

| Plane (our module)                                    | Reference layer               | Status                                |
| ----------------------------------------------------- | ----------------------------- | ------------------------------------- |
| **Gateway** (Off Grid AI Gateway, :7878)              | AI plane / Control chokepoint | ✅ built (desktop) + console reads it |
| **Fleet**                                             | Control (devices)             | ✅ console (enroll/policy/kill/audit) |
| **Control** (policy, guardrails, egress, audit, RBAC) | Control plane (C)             | ✅ console                            |
| **Data** (connectors, ingest, masking, catalog, DSAR) | Data plane (A)                | ✅ console                            |
| **Brain** (LanceDB ingestion→retrieval)               | AI plane (B)                  | ✅ console                            |
| **Agents** (pre-built use cases)                      | Consumption (D)               | ⬜ scaffold                           |
| **Analytics** (usage, latency, drift, perf)           | Control observability         | ✅ console                            |
| **Reports** (regulator-ready exports)                 | Consumption (D)               | ⬜ scaffold                           |
| **Regulatory** (framework mapping, DPIA export)       | Org/Regulatory (E)            | ✅ console                            |

Layer order (linear story): **Data → AI → Control → Org/Regulatory → Consumption.**

## 4. Architecture principles (the spine)

1. **Gateway-first chokepoint.** Every model/tool call passes through the gateway. It's the
   one place policy is enforced and findings are produced.
2. **Findings are produced at hooks, normalized onto the audit record.** (Portkey/Bifrost
   pattern.) Pre-hooks (PII, injection — sync, can block/redact) and post-hooks (grounding,
   eval — mostly async/log). Each check returns `{name, verdict, score, ms}`; the gateway
   stamps a `checks[]` array onto the audit event alongside the `outcome` (ok/redacted/blocked
   ≈ Portkey's 200/246/446). One normalized record → queryable, exportable (DPO pack),
   tool-agnostic. **Findings live on our record, not scraped from each tool's DB.**
3. **Observability = emit OpenTelemetry once.** The gateway emits OTel spans/metrics; any
   backend (SigNoz / VictoriaMetrics / Langfuse) ingests the same stream. No bespoke wiring
   per backend.
4. **Thin adapters (capability ports).** The console depends on small stable interfaces
   (`LogsProvider`, `SecretsProvider`, `VectorStore`, `PolicyEngine`, `CheckAdapter`, …); each
   tool is an adapter behind the port. Swap tool = swap adapter; console untouched. Proven
   in-repo: gateway over HTTP, Brain via a lib interface (LanceDB swappable), Postgres via
   Drizzle.
5. **Tiered integration — native vs embed.** Each capability declares `render: 'native' |
'embed'`:
   - **Tier 1 — commodity:** our UI over the API (secrets, vector store, audit query, basic
     metrics, RBAC). _Built._
   - **Tier 2 — common-80% native, deep-20% embed:** drift (our cards + deep-link),
     policies (Monaco + OPA eval — OPA has no heavy UI anyway).
   - **Tier 3 — rich UI, don't rebuild:** Grafana-class dashboards, Keycloak admin, eval
     explorers → **embed their UI inside our shell** (iframe/reverse-proxy, SSO + theme).
     Framing, not white-labeling; zero UI maintenance.
6. **Out-of-process = legal safety.** OSS runs as separate services the console calls over
   APIs — mere aggregation, so copyleft can't infect our code and any module can be
   closed-source.
7. **Worker-owns-raw, org-sees-distilled.** Capture-derived knowledge: raw stays on the
   device; only distilled knowledge flows to the Brain. Ethical + architectural line.
8. **First-party vs orchestrated.** We build the **Gateway, Console, Brain pipeline, Agents,
   adapters**. Everything else is permissive OSS we orchestrate (no lock-in).

## 5. Integration model (how a tool gets in)

For each tool: (a) runs as a container; (b) a thin **adapter** implements its capability
port; (c) it's **config-driven** (which adapter is active per deployment, like the module
registry); (d) findings flow via the gateway hook → `checks[]` on the audit record; (e)
observability via OTel; (f) UI is `native` (we draw) or `embed` (iframe in our shell).
Versioning: pin per release, adapters absorb breaking changes, upgrade one tool at a time,
one compatibility test per adapter.

## 6. The findings/data model

- `audit_events`: who · model · tokens · leftDevice · outcome · latencyMs · **`checks[]`** (the
  normalized hook results).
- Drift / perf / eval are **computed over the accumulated audit store** (Analytics already
  does recent-vs-baseline) — not read from a tool's private DB.
- DPO export packs are generated from the same normalized store → defensible, tool-agnostic.

## 7. Licensing & legal

- **Permissive-only shipped stack** (MIT/Apache/BSD/ISC/MPL). The 5 swaps already chosen:
  Grafana/Loki/Tempo + Phoenix → **SigNoz / VictoriaMetrics/Logs**; MinIO → **SeaweedFS**;
  Airbyte → **Meltano**; Vault → **OpenBao**.
- **CI license gate** (`license-checker`) fails the build on any GPL/AGPL/SSPL/BUSL/Elastic.
  Verified: the console's installed deps currently have **none**.
- **Out-of-process** keeps copyleft tools (if ever used) as separate services = aggregation.
- **One counsel review** before commercial GA. Diagrams/assets are first-party (Wednesday).
- Full detail: `console/LICENSES.md`.

## 8. Multi-tenancy, identity, ABAC

- **Admin/provisioning module** (multi-tenant): tenants/orgs, who the console is provisioned
  for, and their access. Build **now** to avoid a retrofit.
- **ABAC on top of RBAC** (RBAC already built): attributes = tenant · purpose · data-class,
  enforced at the gateway and on each tool/data slice. Policy-as-code via OPA (Monaco editor
  - OPA eval API — Tier-2 native).
- **SSO** (Google + Microsoft Entra via Auth.js) shipped; Keycloak at scale.

## 9. What's built & verified (today)

Console (Next.js, on Postgres + LanceDB + SSO + live `:7878` gateway): M0 shell + API +
Scalar docs · M1 Fleet + Auth + Postgres · M2 Control (policy editor, history, RBAC, audit) ·
M3 Data · M4 Brain (LanceDB RAG, gateway embeddings, semantic search) · Analytics
(drift + perf) · Regulatory (framework coverage + DPIA export) · public landing (motion,
5-layer deep pages with diagram galleries, OSS map, à-la-carte packaging, mobile carousels).
All `tsc`/lint/prettier clean; APIs validated by curl.

## 10. Roadmap / backlog (sequenced)

1. ✅ **Findings spine** — `checks[]` on audit + `Hook`/`CheckAdapter` interfaces + OTel seam.
2. ✅ **Multi-tenant Admin + ABAC** — tenants/provisioning + ABAC rules (deny-overrides),
   internal Admin module, evaluate endpoint.
3. ✅ **Adapter layer** — `src/lib/adapters/` capability ports (inference/observability/
   secrets/guardrails/retrieval) + adapters, swap via `OFFGRID_ADAPTER_<CAP>`, `render:
native|embed|headless`; Brain embeds through the inference port; `/admin/adapters` API +
   Admin "Integrations · adapters" surface.
4. ✅ **Evals + golden sets** — golden query→expected-doc sets over the Brain; recall-scored
   runs persisted; surfaced in the Brain module; `/admin/golden-cases` + `/admin/evals` API.
5. ✅ **Agents & Reports module bodies** — pre-built agent catalog (`/admin/agents`); regulator-
   ready live-generated exports (`/admin/reports/{id}/export`: compliance/audit/eval/inventory).
6. ✅ **Grounding / attribution (standalone)** — `grounding` capability port; verify an answer
   vs caller-supplied sources (`/admin/grounding/verify`) with NO Brain/store dependency;
   default = gateway entailment (NLI), swappable to offline lexical. Sellable without the Brain.
7. 🟢 **Retrieval router (the spine)** — intent classify → route across KB / database / tool
   sources, fuse with RRF, provenance on every hit. `/admin/retrieve` + `/admin/sources`, tested.
   Brain is one leaf behind it. **Ingestion layer + vector-DB UI ✅** (text/file/image/database,
   `/admin/brain/ingest`). **Router UI ✅** (Brain → Retrieval router console). **Tool registry +
   config UI ✅** (`/admin/tools`, Brain → Tools & services; the router's `tool` source).
8. ✅ **Canonical OSS stack (Docker Compose).** One `deploy/docker-compose.yml`, 19 services,
   profiled by capability (data·ai·secrets·guardrails·policy·identity·observability·lineage·
   llmops·agents) → variants derive from it. Validated, no port collisions. Adapter connections
   (health-probed) for OPA, Keycloak, Presidio, Marquez, Langfuse, pgvector, Qdrant + OpenBao/OTel.
9. ✅ **Tier-3 embeds** — SSO'd iframes for rich OSS UIs (SigNoz, OpenBao, Keycloak, Marquez,
   Langfuse), driven by `render:'embed'` + `embedUrl`. Mere aggregation → license never touches core.
10. ✅ **Model routing (smart + conditional + cloud leash)** — `routing_rules` evaluator folded into
    the policy bundle; `/admin/routing` + `/evaluate`; Control-plane UI + tester. PII→local, etc.
11. ✅ **Node↔console wiring** — desktop node client (enroll→policy→audit→commands) + Settings UI.

## 10b. Backlog (approved, sequenced) — toward Portkey/Bedrock parity

a. **Infra:** Redis (cache + rate-limit), OpenSearch (SIEM), Unleash (feature flags) → compose +
`caching`/`siem`/`flags` capabilities.
b. **Caching** (first-party): exact + semantic response cache, Redis-backed (we own it).
c. **Feature-flag module control**: module/capability enablement routed through flags (Unleash).
d. **Prompt registry**: first-party templates + versioning (Langfuse optional backend).
e. **Evals expansion**: promptfoo (Node) + Ragas/DeepEval (service); golden-set stays baseline.
f. **FinOps + token issuance**: virtual keys scoped to user/project, budgets, cost = tokens×price.
(Gaps we are NOT closing per decision: reversible tokenization vault, Ranger cell-level policies.)

## 11. Principles to never break

Single interface (ours) · gateway is the chokepoint · findings normalized onto the audit
record · OTel as the one observability wire · permissive-only shipped · out-of-process
aggregation · worker-owns-raw / org-sees-distilled · embed don't rebuild rich UIs · no tool's
copyleft ever linked into a closed module · **from the Off Grid ecosystem the console reuses only
two things — the UI (design system) and the single Off Grid AI Gateway; it pulls in NO other
Off Grid packages (no `@offgrid/rag`, no desktop/mobile code) and stands on its own stack.** ·
**all model/inference (embeddings, grounding/NLI, multimodal) routes through that one gateway —
never a third-party LLM; everything else is the console's own third-party OSS behind ports.** ·
**every capability is sellable alone (grounding without the Brain, the Brain without agents, …);
nothing couples to the Brain.** · **the console covers all five planes (data / control / AI /
regulatory / consumption); the core primitives of each — the audit log, the per-request traffic
log, the guardrail policy engine — are FIRST-PARTY and always on; OSS (VictoriaMetrics, OpenBao,
Presidio, …) only augments for scale/depth and can be removed without losing the function.**
