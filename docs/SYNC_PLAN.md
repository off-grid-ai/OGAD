# Off Grid — Cross-Device Sync & Offload Plan

> **Vision:** every Off Grid device is a window onto _all_ of your information.
> Open the phone, the laptop, the tablet — same chats, same projects, same
> memory, same search — and when a more capable device is nearby, heavy work
> (LLM inference, big search, media) transparently runs there. No cloud, no
> accounts, all on your own devices, only when they're on the same network /
> in vicinity.
>
> **And then it makes sense of all of it:** because every device ends up holding
> the same unified corpus, the local model on _any_ device can search, reason,
> and reflect across everything — every chat, project, and memory — no matter
> which device created it.

Status: **planning**. Nothing here is built yet except the pieces noted as
"exists" below. This document is the thing to review before we start.

---

## 1. Principles (do not drift)

- **Local-first, no cloud.** Devices talk **directly** over the LAN. Not a
  single byte goes to a server we own. (Same posture as the rest of Off Grid.)
- **One encrypted session, reused for everything.** All cross-device traffic
  rides the existing `@offgrid/sync` NaCl-encrypted, paired channel. We do **not**
  open a second unauthenticated LAN port.
- **Seamless by default.** Discovery + connection + routing are automatic. The
  user pairs once; after that, "nearby" devices just work. The only visible
  surface is a status indicator and a settings screen for what syncs.
- **Pro-gated, Keygen-owned.** Cross-device is a Pro feature. Entitlement is the
  cached Keygen `isProEntitled()` boolean already present on both apps. The
  5-machine Keygen cap is the only device limit — `@offgrid/sync`'s own
  device-cap code stays dormant (no policy injected).
- **Membership = Keygen, pairing = automatic.** Any device that has activated
  the same license key is trusted to join the mesh — no separate allowlist.
  Because both devices already hold that shared secret (the license key), we
  **seed the encrypted channel from it and auto-pair on discovery with zero
  prompts.** (Manual passphrase remains as a fallback / cross-account case.)
- **A mesh, not a pair.** Up to 5 of your devices (the Keygen cap) form one
  personal mesh. Replication converges across all of them; live RPC can target
  whichever capable peer is present.

---

## 2. Architecture at a glance

```
        ┌─────────────────────────────────────────────────────────────┐
        │                  @offgrid/sync  (per peer link)               │
        │   mDNS discover  →  TCP connect  →  passphrase pair  →         │
        │   NaCl secretbox (XSalsa20-Poly1305) encrypted frames         │
        └─────────────────────────────────────────────────────────────┘
                 │                                   │
   ┌─────────────┴─────────────┐       ┌─────────────┴──────────────┐
   │  TRAFFIC 1: REPLICATION   │       │   TRAFFIC 2: LIVE RPC       │
   │  (state that lives on     │       │   (work that needs a peer   │
   │   every device)           │       │    present right now)       │
   │                           │       │                             │
   │  • chats                  │       │  • LLM offload (chat/visn)  │
   │  • projects + threads     │       │  • global search fan-out    │
   │  • memory / entities      │       │  • large media on demand    │
   │                           │       │    (capture frames, files)  │
   │  op-log, Lamport + LWW    │       │  request/response + stream  │
   │  → converges offline      │       │  proxied to local :7878     │
   └───────────────────────────┘       └─────────────────────────────┘
```

**Two traffic types, one transport:**

|                    | Replication                            | Live RPC                                 |
| ------------------ | -------------------------------------- | ---------------------------------------- |
| **What**           | chats, projects, memory                | LLM offload, global search, media fetch  |
| **Pattern**        | bidirectional op-log, converges        | request/response (+ token streaming)     |
| **Available when** | always (data is local on every device) | only when the target peer is in vicinity |
| **Channel**        | `@offgrid/sync` `app` channel `state`  | `@offgrid/sync` `app` channel `rpc`      |

**Why tunnel RPC through `@offgrid/sync` instead of binding the gateway to
`0.0.0.0` + a token:** the gateway (`:7878`) and `universalSearch()` stay
`127.0.0.1`-only; the desktop proxies tunneled requests to its _own_ localhost.
That gives us E2E encryption, no new attack surface, and reuses pairing + pro
gating for free. "In vicinity" is simply: the paired peer is visible on mDNS.

---

## 3. What exists vs. what we build

### Already built (leverage)

- **`@offgrid/sync`** (`shared/packages/sync`): `SyncEngine`, `TransportBridge`
  abstraction, NaCl crypto, passphrase challenge-response pairing, mDNS via
  `bonjour-service`, generic `onAppMessage` channel, **Node** TCP + discovery
  adapters. Multi-peer capable.
- **Desktop**: OpenAI-compatible gateway on `127.0.0.1:7878`; hybrid FTS+vector
  `universalSearch()`; encrypted SQLite (chats, projects, memory); Keygen
  licensing with `isProEntitled()`.
- **Mobile**: single `LLMService` routing point + `RemoteServerStore`
  (can already target a remote OpenAI server); on-device `llama.rn`; Keygen
  licensing mirroring desktop (same account/product).

### Gaps to close (the actual work)

1. **RN `TransportBridge` adapter** for `@offgrid/sync` (only Node exists). ← critical path
2. **RN mDNS adapter** (browse/advertise `_offgrid._tcp`).
3. **Op-log replication layer** for chats + projects (extend ROADMAP 1.2/1.3
   from "memory" to chats/projects); align IDs to UUIDs.
4. **RPC tunnel** handlers on desktop (proxy to `:7878` and `universalSearch`)
   and client on mobile.
5. **Mobile routing policy**: prefer a nearby paired desktop for inference;
   fall back to on-device when it leaves.
6. **Pairing + status UI** on both apps.

---

## 4. Cross-platform feasibility — four OSes, two codebases

Off Grid is **two products**: the Electron **desktop** (macOS + Windows) and the
RN **mobile** app (iOS + Android). The mesh must span all four. Every sync
primitive is already cross-platform, so this is two adapter implementations
(one Node, one RN), not four.

**Per-primitive support:**

| Primitive      | Desktop adapter (Electron/Node)                                   | Mobile adapter (RN)                                       |
| -------------- | ----------------------------------------------------------------- | --------------------------------------------------------- |
| TCP transport  | Node `net` (macOS ✅ / Windows ✅)                                | `react-native-tcp-socket` (iOS ✅ / Android ✅)           |
| mDNS discovery | `bonjour-service` — pure JS over UDP 5353 (macOS ✅ / Windows ✅) | `react-native-zeroconf` → iOS Bonjour ✅ / Android NSD ✅ |
| Crypto (NaCl)  | `tweetnacl` pure JS (all ✅)                                      | `tweetnacl` + `react-native-get-random-values` (all ✅)   |
| Large media    | HTTP-on-dynamic-port (all ✅)                                     | HTTP-on-dynamic-port — bypasses RN bridge (all ✅)        |

So **one Node adapter covers macOS + Windows**, **one RN adapter covers iOS +
Android**. `@offgrid/sync`'s wire/crypto/pairing core is shared by both.

**Per-OS config & caveats (the only platform-specific work):**

| OS          | What's needed                                                                  | Notes                                                                                                                                                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS**   | nothing                                                                        | Bonjour native; works today                                                                                                                                                                                                                                                                                                            |
| **Windows** | Firewall allow-rule for the app (inbound TCP + UDP 5353)                       | NSIS installer should add it, else first-listen prompt. mDNS binds 5353 with `SO_REUSEADDR` to coexist with the OS responder. **Desktop-as-offload-server also needs the Windows `llama-server` build, which is currently parked in CI** — replication/search work regardless; offloading _to_ a Windows desktop waits on that binary. |
| **iOS**     | `NSLocalNetworkUsageDescription` + `NSBonjourServices` listing `_offgrid._tcp` | Declarative Info.plist entries; without them iOS 14+ hides the service. One-time OS permission prompt.                                                                                                                                                                                                                                 |
| **Android** | `WifiManager.MulticastLock` while browsing; `INTERNET` permission              | `react-native-zeroconf` handles NSD; acquire/release the multicast lock around discovery for reliability.                                                                                                                                                                                                                              |

Conclusion: **all four platforms are supported from the existing two codebases.**
Per-OS deltas are config (plist / firewall / multicast lock), not forks.

---

## 5. Data model & sync semantics

### Convergence model (ROADMAP 1.2)

- **Append-only op-log** per record type: each change is an op
  `{ id, entity, entityId, field/patch, lamport, deviceId, ts }`.
- **Lamport clock** for causal ordering; **last-writer-wins** on `(lamport, deviceId)`
  ties. Tombstones for deletes.
- Each device **materializes** ops into its native store (SQLite on desktop,
  SQLite/AsyncStorage on mobile) → identical tables regardless of op arrival order.
- Sync handshake over the `state` channel: `have` / `want` / `ops` / `ack`
  (the message types ROADMAP already names for memory; reused here).

### ID alignment (must-do before bidirectional)

| Record                   | Desktop today                 | Mobile today | Sync requirement                                    |
| ------------------------ | ----------------------------- | ------------ | --------------------------------------------------- |
| Conversation             | `id TEXT` (UUID) ✅           | UUID ✅      | already compatible                                  |
| **Message**              | `id INTEGER AUTOINCREMENT` ❌ | string id    | **migrate to UUID** (autoincrement isn't mesh-safe) |
| Project                  | `id TEXT` (UUID) ✅           | UUID ✅      | compatible                                          |
| Thread / project_message | mixed                         | mixed        | give messages UUIDs                                 |

Desktop migration: add a stable `uuid` to `messages` (or switch PK), keep the
old autoincrement for local FK joins. Mobile: messages already have ids; ensure
they're UUIDs. Both stamp `updated_at`/`lamport` on every write.

### What replicates vs. fetches on demand

- **Always replicate (small):** chats, projects, memory text/metadata, entities.
  → instant local search on _every_ device.
- **Fetch on demand (large):** capture frames/screenshots, recording media,
  big files — pulled over the RPC/large-file path only when opened.

---

## 6. Phased plan

Each phase ends in a checkpoint mirroring the workspace ROADMAP (C4/C5).

### Phase A — Pairing foundation _(unblocks everything)_

**Goal:** any two of your devices discover each other, pair once, and hold an
encrypted session.

- A1. Build `@offgrid/sync` **RN transport adapter** (`react-native-tcp-socket`)
  implementing `TransportBridge`.
- A2. Build **RN mDNS adapter** (`react-native-zeroconf`) advertise + browse
  `_offgrid._tcp`; add desktop advertise (Node adapter exists).
- A3. Embed `SyncEngine` in **desktop main** and **mobile**; construct it with
  **no `DeviceCapPolicy`** (Keygen owns the cap).
- A4. **Auto-pairing from the license key.** Seed `@offgrid/sync`'s key
  derivation from the activated Keygen key so two devices on the same license
  derive the same channel key and pair on discovery with **no passphrase
  prompt**. Run the existing challenge-response to prove possession; persist the
  shared secret (electron safeStorage / RN Keychain). Keep manual passphrase
  entry as a fallback.
- A5. One-line **`isProEntitled()` guard** on each side before pairing/serving —
  this is the membership check (authed device = allowed device).
- A6. **Per-OS config:** iOS `Info.plist` (`NSLocalNetworkUsageDescription` +
  `NSBonjourServices`); Android multicast lock; Windows installer firewall rule
  (inbound TCP + UDP 5353). macOS needs none.

**Checkpoint A:** phone and laptop discover each other on the LAN, pair with a
passphrase, and exchange an encrypted ping. (= ROADMAP C1.1 across platforms.)

### Phase B — Chats + Projects replication (**bidirectional**)

**Goal:** create/edit a chat or project on any device; it appears everywhere.

- B1. Op-log schema + materializer (shared TS in `@offgrid/sync` or a new
  `@offgrid/memory`-style package) with Lamport + LWW + tombstones.
- B2. **Message UUID migration** (desktop) + write-path stamping on both.
- B3. `state` channel sync handshake (`have`/`want`/`ops`/`ack`); gossip across
  all present peers.
- B4. Wire desktop chat/project writes and mobile Zustand stores through the
  op-log (emit on local change, apply on remote op).
- B5. Conflict UX: silent LWW for fields; deletes win via tombstone; surface
  nothing unless truly divergent.

**Checkpoint B:** a chat started on the phone shows on the laptop and vice-versa;
edit both offline, reconnect, both converge identically. (= ROADMAP C1.2 / C4.1.)

### Phase C — Global search + LLM offload (the "seamless offload")

**Goal:** search all your info from any device; run models on the best nearby
device automatically.

- C1. **RPC channel** over the tunnel: `rpc/llm.chat`, `rpc/search.universal`,
  `rpc/media.fetch`. Desktop handler proxies to `127.0.0.1:7878` /
  `universalSearch()` and **streams** token deltas/results back as frames.
- C2. **Mobile routing policy**: when a paired, pro, capable peer (desktop) is
  present, auto-prefer it for inference; expose it as a "Desktop (nearby)"
  provider in the existing `RemoteServerStore`; fall back to on-device the
  instant it disappears. (Replaces the Ollama/LM-Studio IP-scan for our own
  devices with mDNS presence.)
- C3. **Unified search UX**: local results are instant (replicated); optionally
  fan out an `rpc/search` to present peers for anything not replicated (e.g.
  full capture corpus) and merge.

**Checkpoint C:** from the phone, search returns desktop memory instantly, and a
chat completion runs on the laptop's model automatically because it's nearby.
(= ROADMAP C5.1 + your offload goal.)

### Phase D — Cross-device intelligence ("make sense of all of it")

**Goal:** any device reasons over the _whole_ mesh's information as one corpus.

- D1. Point each device's RAG / search / reflect at the **merged store** (the
  replicated chats + projects + memory + entities), so the local model answers
  over everything regardless of origin device.
- D2. **Provenance-aware** context: results/citations note which device a memory
  came from; "reflect" spans the full cross-device timeline.
- D3. Heavy reasoning auto-offloads to the most capable present peer (reuses the
  Phase C tunnel) — e.g. the phone asks a question; the laptop's bigger model
  answers over the unified corpus and streams back.
- D4. (Ties to ROADMAP Phase 2B) only explicitly-shared, scoped _intelligence_
  crosses devices — never raw frames by default.

**Checkpoint D:** ask a question on the phone that can only be answered from data
created on the laptop, and get a correct, cited answer — reasoned locally/offloaded,
never via cloud.

### Phase E — Parity expansion _(ROADMAP Phase 5, later)_

Mobile screen capture (ReplayKit / MediaProjection + Vision / ML Kit),
integrations, universal clipboard via the `@offgrid/clipboard` RN bridge — all
riding the same mesh. Brings mobile toward feature parity with desktop.

---

## 6.1 Platform rollout — one at a time

Phases A–E are platform-agnostic. We light up OSes **incrementally**: a platform
is "enabled" once it passes **Checkpoint A** (discovers + auto-pairs + encrypted
ping) and then joins replication. Recommended order, easiest/most-built first:

1. **macOS desktop** — the anchor. Most mature (gateway + search already work);
   build the Node `@offgrid/sync` adapter and the desktop side here first.
2. **Android** — first mobile target. EasyShare's RN `tcp-socket` + `zeroconf`
   code already exists and there's no Local-Network-permission gate, so it
   proves the RN adapter and Node↔RN wire parity fastest.
3. **iOS** — same RN binary; delta is the two `Info.plist` keys + the one-time
   Local Network permission prompt.
4. **Windows desktop** — last. Joins **sync + search** as soon as the Node
   adapter ships, but **offload-as-host** waits on the parked Windows
   `llama-server` build.

Each new platform only has to clear Checkpoint A to join an already-working mesh;
the replication/RPC layers don't change per OS.

---

## 7. Seamlessness — the UX contract

This is the part that has to feel magical, so it's explicit:

- **Discovery is automatic & continuous.** Devices advertise on launch; browse
  refreshes (~every 15s, as EasyShare does) so a device that wakes/joins is
  found in 1–2s.
- **Reconnect is automatic.** A previously-paired peer that reappears resumes
  without re-pairing (the `DiscoveryOrchestrator` already models this).
- **Routing is automatic.** No "pick a server" step: nearby capable peer →
  offload; gone → on-device. A subtle indicator shows where inference is running.
- **One status surface + one settings screen.** Status: which devices are
  nearby/paired and what's syncing. Settings: toggles for what replicates
  (chats / projects / memory) and whether to offload inference.
- **Zero-touch pairing.** Devices on the same license auto-pair on first
  discovery (key seeded from the license) — no passphrase step at all in the
  common case.

---

## 8. Security model

- **Pairing:** passphrase never leaves the device; only PBKDF2-style derived
  proofs (existing `@offgrid/sync` crypto).
- **In transit:** every post-pairing frame is XSalsa20-Poly1305 (NaCl secretbox)
  with a fresh nonce; integrity via Poly1305 (+ SHA-512 for file checksums).
- **At rest:** desktop already encrypts SQLite (safeStorage key); mobile stores
  the shared secret + license in Keychain.
- **No open ports:** gateway/search stay loopback; remote access only through
  the paired, encrypted session.
- **Entitlement:** pairing + serving gated by `isProEntitled()` on both ends.

---

## 9. Risks & mitigations

| Risk                                          | Mitigation                                                                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| iOS Local Network permission friction         | Clear `NSLocalNetworkUsageDescription`; graceful prompt + fallback messaging                                                     |
| Token streaming over framed encrypted channel | Stream deltas as small `app` frames (wire format already frames); backpressure aware                                             |
| Autoincrement message IDs break sync          | UUID migration in Phase B before bidirectional                                                                                   |
| Op-log divergence / clock skew                | Lamport clock (not wall-clock) for ordering; LWW only as tiebreak                                                                |
| Battery / radio on mobile                     | Pause browse in background; keepalive paused during transfers (EasyShare pattern)                                                |
| RN ↔ Node framing parity                      | Same `@offgrid/sync` wire code on both; conformance test across all 4 OSes                                                       |
| Windows firewall blocks listen / mDNS         | Installer adds an allow-rule (inbound TCP + UDP 5353); bind 5353 with `SO_REUSEADDR` to coexist with Windows' own mDNS responder |
| Android drops multicast mDNS packets          | Acquire `WifiManager.MulticastLock` while browsing; release when idle to save battery                                            |
| Offload to a Windows desktop                  | Gated on the parked Windows `llama-server` build; until then Windows is a sync/search peer, not an inference host                |
| Replicating huge capture corpus to phone      | Replicate metadata/text only; frames/media fetched on demand                                                                     |

---

## 10. Decisions

**Resolved**

- Licensing/device cap → **Keygen only (5 machines)**; `@offgrid/sync` injects no
  cap policy. Phone + laptop each activate the same key.
- **Scales per-license, not globally.** The cap is per license key (a
  server-side Keygen policy value you own, not hardcoded). Selling N licenses =
  N independent ≤5-device meshes; no aggregate limit. The license-seeded channel
  key also isolates tenants: different customers on the same LAN can't pair or
  decrypt each other.
- Chats/projects → **bidirectional** from the start.
- Platforms → **all four: macOS + Windows (Electron) and iOS + Android (RN)**,
  from the two existing codebases. Per-OS deltas are config only (plist /
  firewall / multicast lock). Caveat: offloading _to_ a Windows desktop awaits
  the parked Windows `llama-server` binary; sync/search to/from Windows do not.

**Open (not blocking the plan; decide before Phase C)**

- Routing policy default: auto-offload whenever a desktop is present, or only
  on Wi-Fi / when charging / above a model-size threshold?
- Search default: replicate-and-search-locally only, or always fan out live to
  present peers and merge?

---

## 11. First step

Phase A1+A2: stand up the RN `TransportBridge` + mDNS adapters and prove a
desktop↔phone encrypted ping (Checkpoint A). Everything else builds on that
session. On your go, I'll expand Phase A into a file-by-file checklist (adapter
API surface, mDNS wiring, pairing screens) and start there.
