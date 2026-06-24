# Off Grid Console — build plan (the SaaS for the 4 planes)

The **org-side web application** — the UI and backend for the Control / Data / AI /
Regulatory planes. This is **Fleet Control's console + the Gateway/Brain admin surface**:
the "app that connects to all the nodes" (Off Grid Desktop/Mobile). Next.js.

This is a **new, separate product** from Off Grid Desktop. The nodes already carry the
gateway and enforce policy locally (see `ENTERPRISE_BUILD_PLAN.md`). The Console does **not**
run the intelligence or enforce policy — it **defines and observes**: provisions policy +
knowledge + config *down* to the fleet, aggregates audit + telemetry + distilled learnings
*up*.

---

## Where it fits

```
   ┌─────────────────────────  OFF GRID CONSOLE (Next.js, this plan)  ─────────────────────────┐
   │  Control plane UI · Data plane UI · AI plane (Brain) UI · Regulatory (DPO) UI · Fleet mgmt │
   │                              + backend (API · DB · node protocol)                          │
   └───────────────┬───────────────────────────────────────────────────────┬──────────────────┘
        policy / config / SOPs  ▼ (down)                    audit / telemetry / learnings ▲ (up)
              ┌─────────────────────────── FLEET OF NODES ───────────────────────────┐
              │  Off Grid Desktop / Mobile — gateway baked in, enforces policy locally │
              └───────────────────────────────────────────────────────────────────────┘
   Org systems (DBs · warehouses · SaaS) ──connectors──► Brain (org knowledge)  ◄── Console manages
```

The Console is the **define/observe** half of every control; the node is the **enforce/emit**
half. The Console is useful only once nodes can emit audit and accept policy — that's the
node-side dependency (below).

---

## Modularity & packaging — buy only what you want

Nothing is all-or-nothing. Every capability is **API-first and independently adoptable** — a
customer takes any subset and never the whole ecosystem to use one part:

- **Just the API** — Gateway / Brain / Agents are headless services with documented APIs.
- **API + UI** — add the Console (this app) as an optional layer over any subset of services.
- **Just the AI agent use cases** — the pre-built agents, standalone.
- **Just the Brain / knowledge store** — the **ingestion→retrieval (RAG) pipeline** on its
  own (the part we have the most depth on: parse → chunk → embed → index → retrieve →
  rerank → cite). Standalone product.
- **All of it** — the full common control plane.

Baked into the build:
- **API-first.** Every module exposes its function over a documented API; the Console UI is
  one consumer of that same API. "API only" is free — it's the contract the UI uses.
- **Independent modules.** Each plane/service (Gateway, Brain, Agents, Data/ingest, Fleet,
  Regulatory) deploys and licenses on its own; the Console shows only the modules a
  deployment enables (a module registry, env-driven).
- **Graceful degradation.** A module works with siblings absent (Console with Brain off
  hides the Brain section; Gateway runs with no Console at all).

## What's needed to start (decisions to lock first)

These five decisions shape everything; pick them before/at kickoff:

1. **Deployment model.** Default: **self-hostable, single-tenant per org** (one org = one
   Console instance, on the org's infra) — required by the "data never leaves" thesis. A
   managed/multi-tenant offering can come later, but build single-tenant first.
2. **Node ↔ Console protocol.** Default: **pull-based over HTTPS** (nodes poll for
   policy/config/SOPs, push audit batches up). Firewall/NAT-friendly, works when nodes go
   offline, simplest to secure. Add optional SSE/WebSocket for near-instant kill-switch when
   a node is online; fall back to poll otherwise.
3. **Auth / identity.** Admin console auth via **OIDC** (self-hosted Keycloak, or Auth.js
   against the org's IdP). RBAC roles: `admin`, `compliance/DPO`, `viewer`.
4. **Datastore.** **Postgres** for fleet state (devices, policies, users, RBAC) + an **audit
   index**. Decide raw-audit storage: keep raw on the node and pull on demand, or ship to an
   object store with a queryable index in Postgres. (Lean: index in PG, raw pulled on demand
   for export — keeps the Console light and the raw data closest to the device.)
5. **Where Brain lives.** Same deployment, separate service: a knowledge service (vector +
   doc store) the Console manages and the org ingest service writes to. The Console is its
   admin UI, not its storage.

**Node-side dependency:** the Console needs the node's gateway to expose three things —
**audit emission**, **policy intake**, and an **enrollment/command channel**. Those are
Stage 1–2 of `ENTERPRISE_BUILD_PLAN.md` (the `model-server.ts` hook pipeline). **The Console
can start now in parallel** by building against a **mocked node API** matching the contract
below, then wiring real nodes once Stage 1 ships.

---

## The node ↔ Console contract (the crux)

Define this API first — both sides build against it. Pull-based, versioned, mTLS or
device-token auth.

| Direction | Endpoint (Console side) | Purpose |
|---|---|---|
| Enroll | `POST /v1/devices/enroll` (with admin-issued enrollment token) | Node registers; Console issues a device identity/token (C4) |
| Policy down | `GET /v1/devices/{id}/policy` | Node pulls current policy bundle (guardrails, egress rules, RBAC, AI-use policy) |
| Config + knowledge down | `GET /v1/devices/{id}/provision` | Intelligence config + SOPs/KB refs the node's role gets (from Brain) |
| Audit up | `POST /v1/devices/{id}/audit` | Node pushes audit batches (calls, what-left-device, tool use) |
| Telemetry up | `POST /v1/devices/{id}/telemetry` | Tokens, latency, eval results, drift signals |
| Learnings up | `POST /v1/devices/{id}/learnings` | Distilled SOPs/patterns (never raw capture) → Brain |
| Commands | `GET /v1/devices/{id}/commands` (+ optional SSE) | Kill switch, re-provision, revoke — node polls/streams |

---

## Feature surface — the four planes as Console sections

Navigation mirrors the planes (and the `ENTERPRISE_BUILD_PLAN.md` component map):

- **Fleet** — device inventory, enrollment, groups/roles, per-role policy + intelligence
  assignment, kill switch. *(C4, C9c, provisioning.)*
- **Control plane** — gateway config (model routing, leashed cloud), guardrail rules
  (input/output), **egress rules**, **audit log explorer**, observability dashboards, RBAC
  authoring. *(C1, C2, C3, C5, C7, C8, C16.)*
- **Data plane** — connectors to DBs/warehouses/SaaS, ingest jobs + status, PII/masking
  rules, data catalog, retention/erasure (DSAR). *(A1, A3, A5, A7, A9, A11, A12a.)*
- **AI plane (Brain)** — KB/SOP management (review, edit, publish "what good is"), model
  registry, retrieval config, **eval + drift** dashboards. *(B2a, B3, B5a, B16, C9, C9a.)*
- **Regulatory** — the **DPO single view**: compliance status, framework→control mapping,
  one-click audit/DPIA export, AI-use-policy authoring. *(E1, E2, E6, C7 rollup.)*

---

## Standards (decision locked)

We follow the Wednesday **Standards Kit** for engineering and component sourcing, and the
**Off Grid brutalist brand** (`docs/DESIGN.md`) for visual identity. Where the kit's *visual*
identity conflicts with Off Grid (it uses green→teal gradients, Instrument Serif, DM Sans,
shimmer, card-lift, rich animation), **Off Grid wins** — the Console is one product family
with the Desktop/Mobile nodes it manages, and a dense compliance/audit tool suits the flat,
information-first look.

**Engineering standards (from the kit — adopted as-is):**
- Cyclomatic complexity **< 8** (no exceptions); refactor over nesting.
- Naming: **PascalCase** (components/types), **camelCase** (logic).
- Strict **import ordering**: React → Next → state → UI → alias → relative.
- Forbidden: `console.log`, magic numbers, unused imports.
- Animate only `transform` / `opacity`; wrap motion in `prefers-reduced-motion`; mandatory
  `aria-label` on icons, `alt` on images; 4.5:1 contrast.

**Visual identity (Off Grid `docs/DESIGN.md` — overrides the kit):**
- Menlo mono everywhere; single emerald accent (`#34D399`/`#059669`), **no gradients**.
- Flat 8px radius, hairline borders, no shadow/lift; hierarchy via size+opacity, not color.
- **No decorative animation** — loading spinner only. (So the kit's animation-timing table
  applies only to the rare functional transition, not to reveals/shimmer.)

## Components — discover from the catalog, source from the library, never build custom

**We do not build UI components, and we do not vendor the repo's copies.** The repo
`wednesday-solutions/component-library-animations` is a **catalog** — an index of the ~399
components that exist across the ecosystem (shadcn, aceternity, animate-ui, cult-ui,
eldora-ui, magic-ui, motion-primitives), with **example implementations**. Use the catalog to
find the *right* component for each need; then bring that component in **from its real source
library**, and re-theme it. The repo's `Button` is an example — we don't import it; we use
the actual library's component.

**Setup (one-time):**
1. Clone `wednesday-solutions/component-library-animations` **inside** the console repo as a
   **reference catalog**.
2. **`.gitignore` that clone** — it's for discovery, not a committed dependency. Checked out
   fresh per environment.

**Workflow (every UI need):**
1. **Discover** — search `skills/component-library-index.md` (indexed **by use case**) +
   `src/componentRegistry.tsx`. Find the right component and note **which library it's from**.
2. **Source it from that library** — install/add the real component from its upstream
   (shadcn via its CLI, aceternity/magic-ui/cult-ui from their source). The catalog's file is
   the *example*; the real library is the *source of truth*.
3. **Re-theme to `docs/DESIGN.md`** — the brand overrides the library's defaults.

If a need isn't in the catalog, find the **closest catalog component** and adapt it — still
no custom-built components.

**The brand guardrail (critical):** much of the ecosystem is decorative — aurora, neon,
gradient, shiny, rainbow, glow. `docs/DESIGN.md` forbids all of it (brutalist, flat, **no
gradients**, **single emerald accent**, Menlo mono, **no decorative animation**). So:

- **Favor the functional set** — shadcn base (Button, Card, Tabs, Table, Dialog, Breadcrumb,
  Pagination, NavigationMenu, Input, Badge…) and structural interaction components. This
  admin console is dense and information-first, not a landing page.
- **Skip the decorative pieces** (AuroraBackground, NeonGradientCard, RainbowButton,
  ShinyText, Meteors, GlowingStars…) — they fight the brand.
- **Re-theme on use:** Menlo `font-mono`, emerald `#34D399/#059669` as the *only* accent,
  flat 8px radius, hairline borders, hierarchy via size+opacity not color. Animation only
  where functional (loading), never decorative.

Net: **zero custom components** — discover in the catalog, source from the real library,
re-theme to Off Grid.

## Tech stack

- **Next.js** (App Router, TypeScript) — UI + route-handler API (or tRPC for typed RPC).
- **Components:** the Wednesday component library above (reuse + re-theme) — **not** a
  hand-built component set.
- **Tailwind v4 + `@offgrid/design`** — brand tokens (Menlo, emerald, brutalist) per
  `docs/DESIGN.md`, applied as the theme over the reused components. Desktop-first, dense.
- **Postgres + Drizzle** (or Prisma) — fleet state + audit index.
- **Auth.js / OIDC (Keycloak)** — admin auth + RBAC.
- **Background worker** — a Node service (or queue, e.g. BullMQ) for org-data ingest jobs,
  eval runs, audit rollups. Separate from the request path.
- **Charts** — a lightweight lib (e.g. visx/Recharts) for observability/compliance views.
- **Docker Compose** — self-host bundle (Console + Postgres + Brain + worker) for on-prem.

---

## Build milestones

Sequenced so the Console is demoable early (against mocks) and useful as soon as nodes land.

1. **M0 — Shell + auth + data model + component catalog.** Next.js app; clone + gitignore
   the component-library-animations repo as a **discovery catalog**; source components from
   their real libraries per the workflow above (no custom, no vendored repo copies); apply
   `@offgrid/design` / `docs/DESIGN.md` theme; OIDC login, RBAC, Postgres schema (devices,
   policies, audit, users). Mocked node API. *Demoable console with a fake fleet, brand-
   matched, components sourced from the library.*
2. **M1 — Fleet foundation.** Enrollment flow, device inventory, push a policy bundle,
   ingest audit, the audit log explorer, kill switch. Wire to **real nodes** once node-side
   Stage 1 ships. *Done when an admin governs a real device from the console.*
   - ✅ **Contract API + OpenAPI/Scalar docs shipped** — the full node↔console lifecycle
     (enroll · pull policy · push audit · poll commands · admin token/policy/kill · fleet
     audit) on a swappable in-memory store; OpenAPI 3.1 at `/openapi.json`, interactive
     playground at `/docs`. Verified end-to-end with curl. **API-first holds: the UI reads
     the same endpoints.**
   - ⬜ **M1 tail:** OIDC auth + RBAC, Postgres (swap the in-memory store), UI interactivity
     (enroll/kill/push buttons) — read views and the contract are live now.
3. **M2 — Control plane UI.** ✅ Policy editor (egress toggle + editable guardrails + allowed
   models, published as a **versioned** policy), **policy history**, **RBAC** (users + role
   change, validated), and the audit log. Gateway section reads the live node gateway
   (`:7878`). *Observability dashboards deferred to the Analytics module.*
4. **M3 — Data plane UI.** ✅ Connectors (add/sync/delete), ingest jobs, PII/masking rules
   (add/toggle), data catalog with classification, and retention/erasure (DSAR). Real
   Postgres tables + admin APIs. *Next: wire ingest into Brain (M4).*
5. **M4 — Brain UI.** ✅ LanceDB ingestion→retrieval (RAG): KB/SOP list + add-document
   (embed+index), semantic search with scored citations. Embeddings via the gateway
   `/v1/embeddings` (deterministic fallback). *Next: eval/drift + model registry.*
6. **M5 — Regulatory / DPO.** Compliance view, framework mapping, one-click audit/DPIA
   export, AI-use-policy authoring. *Done when a DPO can export a defensible pack.*
7. **M6 — Self-host packaging.** Docker Compose bundle, install docs, backup/restore.

---

## Repo & reuse

- **New repo:** `off-grid-ai/console` (peer of `desktop`, `mobile`, `sync`).
- **Reuse:** `@offgrid/design` (tokens/brand). The node↔Console contract types should live in
  `shared` (`@offgrid/fleet-protocol`) so Desktop and Console share one source of truth.
- **Parallelizable now:** M0–M1 UI can be built against the mocked node API immediately, in
  parallel with the node-side gateway hooks (`ENTERPRISE_BUILD_PLAN.md` Stage 1). The contract
  above is the coordination point.

---

## v0 definition of done

An admin logs into a self-hosted Next.js console, sees a fleet (mocked or real), pushes a
policy bundle to a device, and watches that device's audit stream come back — with the
Control/Data/AI/Regulatory sections scaffolded and the brand matching Desktop. Everything
else layers onto that spine.

---

## Status (built & verified)

M0 shell+API+Scalar docs · M1 Fleet+Auth(SSO)+Postgres · M2 Control (policy editor, history,
RBAC, audit) · M3 Data (connectors, ingest, masking, catalog, DSAR) · M4 Brain (LanceDB RAG,
gateway embeddings, semantic search) · Analytics/observability (drift + perf degradation) ·
Regulatory/DPO (framework coverage + DPIA export) · public landing page (motion + 5-layer
diagrams + OSS map). All on real Postgres + LanceDB + SSO + the live `:7878` gateway.

## Backlog (open workstreams — do not lose)

1. **Desktop grounding of the story** — survey `../desktop` so Fleet Control, auto-SOP
   creation, and org-knowledge sync messaging matches what the app actually does
   (capture → synthesize → SOPs; memory + `@offgrid/sync`). *(in progress)*
2. **Multi-tenant Admin module + ABAC/RBAC** — tenants/orgs, provisioning (who the console
   is for + their access), ABAC (tenant/purpose/data-class) layered on existing RBAC. Do now
   to avoid a retrofit. Single interface (ours) — no white-labeling underlying tools.
3. **License & legal audit** — every integrated OSS tool's license vs Off Grid (AGPL-3.0,
   on-prem). Flag AGPL (Grafana/Loki), SSPL/ELv2 (Redis/Airbyte), commercial-only features;
   produce `LICENSES.md` + swap recommendations. Confirm no copyright infringement (diagrams
   are first-party Wednesday assets).
4. **M6 — packaging** — Docker Compose / Helm bundle that brings the console + purchased OSS
   tools up together. "Buy the console → get the whole stack (or opt in per plane)."
5. **Docs: integration points** — show how the console integrates with each underlying OSS
   system (APIs, data flows, seams), single-interface principle.
6. **Evals + golden sets** — run a golden query→expected-doc set against the Brain (LanceDB)
   retrieval; score recall/accuracy; quality gate.
7. **Module bodies** — Agents (pre-built use cases) and Reports (regulator-ready generated
   exports) currently scaffolds.

Architectural principles to hold: **single interface (ours), no white-labeling**; the
**Off Grid AI Gateway is first-party** (everything else is orchestrated OSS, no lock-in);
**worker-owns-raw, org-sees-distilled** for capture-derived knowledge.
