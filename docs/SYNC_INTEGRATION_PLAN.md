# `@offgrid/sync` → Off Grid AI Desktop — implementation plan

Owner: the **desktop** lane. The **mobile** lane runs in parallel on the same engine package.
Status: implementation in progress. M0-M3 and opt-in text clipboard sharing are verified through
the desktop user path. Knowledge-document Sync, portable tool artifacts, transfer queues, persistent
device names, stale-session expiry, and Apple nearby transport are implemented on both hosts. Their
joint physical iOS/macOS gate remains open. M4 has a working first implementation, but its multi-GB,
interruption, and receiver-load gate remains open. M5 remains open. Code present + wired is not
closure (same bar as `docs/GAPS_BACKLOG.md`).

## Scope (first cut, per product direction)

1. **State sync over the LAN** — chats / workspace / projects / model settings converge across a
   user's devices.
2. **Universal text clipboard** — copied text can be shared over the encrypted paired session,
   explicitly off until the user opts in.
3. **Model transfer** — a model downloaded on one device can be moved to another (phone ↔ desktop).
4. **Ambient file sharing** — as designed in `../sync/docs/AMBIENT_SHARING.md` (policy + queue +
   watcher on top of the existing transport).

## Non-negotiable placement rules

| Thing                                                               | Where                                                                                                 | Why                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Sync **engine** (crypto, pairing, wire protocol, transfer, op-log)  | `@offgrid/sync` in `shared/` — **public**                                                             | The encryption and wire format must be auditable. That is the whole point of publishing it. |
| Desktop **integration** of that engine (service, IPC, UI, settings) | `pro/` (the `desktop-pro` submodule)                                                                  | Sync is a **pro feature**. Core must not carry pro business logic.                          |
| Core's share                                                        | `proCatalog` entry + `locked: !isPro` nav item → `UpgradeScreen`; dimmed `ProPlaceholder` in Settings | The inert shell only.                                                                       |
| Pro renderer → main                                                 | generic `proInvoke` / `proOn` passthrough                                                             | Do **not** add per-feature namespaces to the core preload.                                  |

Commit order for pro changes: land in `desktop-pro` first, then bump the submodule pointer in
`desktop` with `git add pro`.

## Cross-lane contract (desktop ↔ mobile, read this first)

> Shared log both lanes update: **`shared/docs/SYNC_CROSS_LANE_LOG.md`** — the entity/channel/column
> contracts, per-lane progress, engine asks, and a corrections log. The authoritative design is
> `shared/docs/DESKTOP_SYNC_INTEGRATION_PLAN.md` (Track A free export/import in core, Track B pro
> sync in `pro/`).

The one guaranteed conflict is two sessions editing `shared/packages/sync`. Therefore:

- **The desktop lane consumes `@offgrid/sync` UNCHANGED.** It already builds and passes 24/24 tests.
- If desktop needs an engine change, it is raised as a **package-level ask** in this doc's
  "Engine asks" section rather than edited in place. The mobile lane does the same.
- Host adapters are injected, never assumed: `NodeTcpTransport` + `NodeDiscovery`
  (`bonjour-service`) on desktop; the RN TCP/Zeroconf modules on mobile. The package never imports
  either — that seam already exists (`src/adapters/{node,rn}-{tcp,discovery}.ts`) and must stay.

### Engine asks (raise here, do not hand-edit the package)

- ~~**A-1 (blocks M4, large models).**~~ **WITHDRAWN — not an engine gap.** Verified against the
  vendored build: the engine already exposes a streaming and an HTTP-accelerated vocabulary —
  `createFileRequestStreaming`, `createFileCompleteStreaming`, `createFileRequestHttp`,
  `createFileAcceptHttp`, `verifyFileIntegrity`. The in-memory `chunkFile` / `reassembleChunks`
  simply coexist with it. So this is a **host-wiring rule the desktop lane owns**, not a blocker on
  the other lane: **model transfer MUST use the streaming/HTTP path and must never call
  `chunkFile` / `reassembleChunks`** (an earlier in-memory cut was rejected for exactly this — see
  `AMBIENT_SHARING.md`). M4 is therefore **not blocked**.
- ~~**A-2 (ACK semantics).**~~ **RESTATED as a host-wiring rule.** `createFileAck` and
  `verifyFileIntegrity` exist in the engine, so the vocabulary is there. G-007 was a defect in
  _EasyShare's desktop_ resolve timing, not in the engine: it resolved `sendFile(true)` after
  emitting chunks rather than after peer confirmation. **Our integration must resolve only on a
  correlated positive ACK following the peer's durable write + integrity check**, and must surface
  negative ACKs. "Synced" that does not mean "written and verified on the peer" silently loses data.
- ~~**A-3 (multi-device).**~~ **CLOSED.** `SyncEngine` owns a set of peer sessions and a
  device-id-to-session map, so the desktop host can keep several encrypted peers connected and
  broadcast state or clipboard messages to the paired set.
- **A-4 (security, and this package is going PUBLIC).** G-001: bespoke iterated-SHA-512 passphrase
  derivation + hash challenge/response, and `sharedSecret` persisted in plaintext (electron-store /
  AsyncStorage). G-002: no payload-shape validation at the protocol boundary; peer-controlled
  messages are cast. Publishing "audit our crypto" while shipping a bespoke KDF and plaintext
  secrets invites the opposite conclusion. Should be fixed **before** the repo is public, and it is
  engine-level, so it belongs to whoever owns the package — not a desktop-lane side edit.
- **A-5 (true unpair).** The desktop can delete the persisted pairing credential, but the public
  engine does not expose a per-device session close. Until that contract exists, "unpair" cannot
  immediately tear down an already-open encrypted session. Keep this visible rather than treating a
  storage delete as full disconnection.

## Milestones

Each milestone states its **verification gate**. No milestone is done without it.

### M0 — Consume the engine (do NOT vendor it)

- **Status: verified.**
- **CORRECTED.** This originally said to copy `shared/packages/sync` → `desktop/packages/sync`,
  following the existing `@offgrid/clipboard|design|models|rag` convention. That is wrong:
  `shared/docs/DESKTOP_SYNC_INTEGRATION_PLAN.md` §1 says explicitly **do not duplicate
  `@offgrid/sync`** — reference it directly, as mobile does:
  `"@offgrid/sync": "file:../shared/packages/sync"`. The vendored copy was removed.
  (The other `desktop/packages/*` copies have silently drifted from `shared/`, which is the
  argument for the direct ref.)
- Add `@offgrid/sync` as a `file:../shared/packages/sync` dep, plus `bonjour-service` (pure-JS mDNS, no
  native build) for `node-discovery`.
- **Gate:** `npx tsc --noEmit` clean on both tsconfigs; the package's own 24 tests pass from the
  vendored copy; `npm run build` produces a working bundle.

### M1 — Pairing + discovery + transport, headless and real

- **Status: LAN verified; Apple nearby transport implemented and awaiting the joint physical gate.**
  Real TCP loopback tests cover pairing, encrypted messages, reconnect, bad passphrases, and more
  than five paired peers.
  `pro/main/sync/`:

- `sync-service.ts` — composes `NodeDiscovery` + `NodeTcpTransport` + the engine. Owns lifecycle and
  teardown (no leaked sockets/timers).
- `sync-store.ts` — persistence behind a **small interface** (`getPairedDevices`, `addPairedDevice`,
  `getSettings`) so the service runs headless in tests. SQLite-backed impl satisfies it. This mirrors
  EasyShare's `ConnectionStorage` seam, which is what made its real test possible.
- Sync does not add a second peer cap. Pro access is owned by licensing, whose five-device seat
  policy automatically replaces the least-recently-seen prior activation when this device signs in.
- `MultiTransportBridge` and `CompositeDiscoveryService` in shared Sync prefer LAN and fall back to
  Apple nearby discovery/transport without changing the encrypted Sync protocol. macOS and iOS use
  MultipeerConnectivity reliable byte sessions with encryption required. BLE and file-type routing
  are not separate paths.
- Shared heartbeat traffic runs every 10 seconds and expires a peer after 30 seconds without
  authenticated traffic, so a removed cable or dead network path cannot remain connected
  indefinitely.
- **Gate:** two real service instances pair over **real TCP loopback** in a test, exchange an
  encrypted message, and tear down cleanly. The remaining physical gate disables iPhone Wi-Fi and
  confirms the same paired devices reconnect over Apple nearby transport, then return to LAN
  without re-pairing.

### M2 — Devices surface + inert core shell

- **Status: verified.** Pro and free-tier Playwright journeys pass, and the captured desktop states
  have been visually checked.
- `pro/renderer/screens/Devices.tsx` — discovered devices, pair/unpair, connection state, transfer
  list. Desktop-first density per `docs/DESIGN.md` (multi-column grid, not one row per 1900px line).
- Register the view through pro's view-router; register a Settings section via
  `registerProSettings`.
- Core: `proCatalog` entry + `locked: !isPro` nav item → `UpgradeScreen`. **No pro logic in core.**
- **Gate:** Playwright e2e asserts the surface renders; free build shows the locked upgrade screen;
  screenshots read and validated (not just captured) before they go in a PR.

### M3 — State sync: chat / projects / model settings converge ← **the "does it actually work" gate**

- **Status: verified.** A real encrypted peer drives chats and projects into the rendered desktop
  UI, desktop-created state reaches the peer, fresh-profile schemas backfill correctly, and the
  real SQLite bridge converges concurrent edits. Deleting a project unfiles its chats instead of
  deleting them.
- Use the engine's `oplog` + `state-sync` (Lamport + last-writer-wins; already pure and tested).
- `pro/main/sync/state-bridge.ts` — maps desktop SQLite entities (chats, projects, model settings)
  to op-log records and applies inbound ops idempotently. Pure mapping isolated from I/O so it is
  unit-testable; the DB write is the thin edge.
- Conflict policy is the engine's LWW — do **not** re-implement it in the bridge (single source of
  truth, per the DRY rule).
- **Gate:** two real app instances on one machine, separate `OFFGRID_USER_DATA` profiles, pair over
  loopback; create a chat on A → it appears on B; edit the same record on both while "offline" →
  both converge to the same LWW winner. Asserted on the **UI**, not just the DB.

### M3b — Universal text clipboard

- **Status: verified in the desktop integration.**
- The existing production clipboard owner emits copied text to a separate sync policy service.
  There is no second OS poller.
- Sharing is off by default, persists through the existing sync preferences owner, and stops when
  either the master sync switch or clipboard switch is off.
- Messages use the existing encrypted application channel, accept at most 256 KiB of UTF-8 text,
  validate peer-controlled payloads, and suppress the write-back capture so received text does not
  bounce to its origin.
- **Gate:** real TCP/encryption integration proves desktop-to-peer delivery, receiver opt-out,
  sender opt-out, malformed and oversized rejection, and anti-loop behavior. Playwright proves the
  default-off control and persistence through the rendered Devices surface.
- Clipboard images and files are not included. They belong on a resumable file-transfer policy, not
  the ephemeral text channel.

### M3c — Knowledge documents across iOS and macOS

- **Status: implemented on both hosts; physical iOS ↔ macOS gate ready to run.**
- Shared Sync owns the portable `knowledge_document` state contract, metadata parser,
  `KnowledgeDocumentSync` ordering/materialization coordinator, `TransferSinkRegistry`, and
  persisted-op rematerialization. Hosts retain only filesystem staging, project lookup, and their
  local RAG import/enable/delete adapters.
- Desktop receives individual source-document bytes, indexes them under the stable project and
  document IDs, refreshes an already-open Project view, and suppresses rebroadcast. Mobile uses the
  same shared coordinator and renders imported documents through its real Project Detail flow.
- Both hosts stage a file until its project and winning state arrive, honor tombstones before
  import, re-read racing control state after import, and retry staged work after restart.
- Transfer attempts are serialized per device by shared `KeyedSerialQueue`. Host UIs retain
  queued/preparing/active/completed/failed activity, show admission and source failures, and offer
  retry/dismiss controls without duplicating transport scheduling.
- **Gate:** manually add a supported text/PDF document on each device and confirm the other device
  shows and can search it without restart. Toggle enabled and delete from each side, then confirm
  convergence. Repeat with iPhone Wi-Fi disabled to prove the nearby route carries both state and
  source bytes. Keep the pre-push gate deferred until this manual-device phase is complete.

### M3d — Chat artifacts, device identity, and physical-test diagnostics

- **Status: implemented on both hosts; physical verification pending.**
- Completed portable tool artifacts are admitted and serialized by shared Sync, then rendered by
  each host's existing tool-result UI without re-running the tool.
- Non-empty short documents such as `op\n` produce an indexed RAG chunk through shared
  `@offgrid/rag`; Mobile consumes the shared chunker instead of maintaining a divergent copy.
- The local device name is editable and persistent on both hosts. Renaming updates live discovery
  advertisement without changing the stable device ID or pairing identity.
- Generic transfer activity and the knowledge send queue are visible on both hosts. A failed or
  rejected source remains visible with its error instead of disappearing.
- **Gate:** manually confirm Desktop tool artifacts render on Mobile, `op.txt` returns its exact
  indexed contents, local rename is advertised to the peer, queue entries are visible, and an
  unplugged/unreachable peer changes from Connected to Offline within about 30 seconds.

### M4 — Model transfer (NOT blocked; use the engine's streaming/HTTP path — see A-1)

- **Status: partial.** The desktop service streams single-file GGUF models without whole-file
  buffering, resumes aligned partial files, verifies the checksum, promotes without clobbering, and
  registers the receiver only after durable completion. Integration tests and the Devices UI pass.
  The milestone remains open until the physical multi-GB, interruption, checksum, and receiver-load
  gate passes.
- Move a downloaded model between devices: streaming, resumable, checksum-verified, and registered
  in the receiver's model catalog (`models/` + `active-model.json`) so it is immediately usable.
- Must not buffer whole files (A-1). Reuse EasyShare's proven streaming + HTTP-accelerated path.
- **Gate:** a real multi-GB-class transfer lands byte-identical (checksum) and the receiving app can
  load the model. Interrupt mid-transfer → resumes or fails cleanly, never a corrupt half-model
  presented as usable.

### M5 — Ambient file sharing (needs the `sharing/*` layer in the engine)

- **Status: open.**
  The policy / queue / watcher layer currently lives in the **sync repo** under `@easyshare/shared`,
  **not** in `@offgrid/sync`. Porting it is an engine change → coordinate, do not hand-edit.
  Then: compose watcher → policy → `FileSender` (over the sync transport) in `pro/main/`, plus the
  share-mode matrix in Settings. macOS watcher at the OS boundary
  (`NSMetadataQuery` on `kMDItemIsScreenCapture` + FSEvents), every event through `shouldEmit`
  (dedup + anti-loop on the app's own save dir).

- **Gate:** an observed screenshot reaches the paired peer with no user interaction, is **not**
  re-shared on receipt, and `off` genuinely sends nothing.

## Risks

- **Vendoring drift.** `desktop/packages/*` copies already differ from `shared/`. Record the source
  commit; re-vendor deliberately.
- **Two lanes, one engine.** Mitigated by the contract above; the engine asks are the pressure valve.
- **Sync that silently loses data** is worse than no sync. A-2 (ACK semantics) is the reason M3's
  gate asserts convergence on the UI of a second real instance rather than trusting a resolved promise.
- **Pro submodule flow.** Land in `desktop-pro` first, then bump the pointer; never commit pro source
  into the public repo.

## Immediate next action

Finish the signed Desktop build with the Apple nearby helper and rebuild/install the Mobile app with
its native nearby module. Restart Metro once for the Mobile shared-RAG resolution change. Then run
the manual M1/M3c/M3d iOS/macOS gates without changing the existing pair. After they pass, run the
deferred pre-push gates once and proceed to M4's physical multi-GB interruption and receiver-load
gate. Resolve A-5 before calling unpair complete. M5 follows only after the shared policy / queue /
watcher contract exists; do not put that policy into the desktop host.
