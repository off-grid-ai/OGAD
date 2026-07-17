# Gaps backlog

Honest log of gaps, regressions, and "not fully done" items. Each entry: what, evidence,
how to reproduce, and the fix direction. Close with evidence; never hide.

---

## OPEN

### Sync integration is not wired - package and renderer seams only

- **Status:** code exists in separate completed lanes; there is no user-facing sync or workspace
  export/import feature in Off Grid AI Desktop.
- **Renderer evidence:** commits `3ab2e4a`, `bb1f8e2`, and `df0b04b` provide reactive feature and
  settings registries. From `/tmp/offgrid-desktop-sync`,
  `npx vitest run src/renderer/src/lib/__tests__/App.feature-registration.test.tsx src/renderer/src/lib/__tests__/featureRegistry.integration.test.tsx src/renderer/src/lib/__tests__/featureRegistry.test.ts src/renderer/src/lib/__tests__/navRegistry.test.ts src/renderer/src/lib/__tests__/screenRegistry.test.ts src/renderer/src/lib/__tests__/sectionRegistry.test.ts`
  passed 29 tests in 6 files. `npm run typecheck` and `npm run build` passed. Existing Vite
  dynamic/static chunk warnings remain informational.
- **Shared evidence:** `@offgrid/sync/portable` commits `4ae1847` and `16d687e` pass their 26 focused
  package tests, typecheck, and package build in `/tmp/offgrid-shared-integration`.
- **Missing owner on this branch:** Desktop adapter work is active in a separate review lane but is
  not landed or wired here. This branch has no sync controller, `WorkspaceDataPort`, `ArchivePort`,
  `BackupSink`, secure credential adapter, IPC surface, registered feature, registered settings
  section, or production dependency wiring.
- **Close when:** the reviewed package is consumed by the Desktop main process, a real registered App
  screen drives export/import through narrow IPC, and the synthetic-profile integration journey and
  screenshots pass.

### Core sync security review is a merge blocker

- **Status:** active in a separate shared-package worktree; not part of this Desktop branch.
- **Required closure:** adversarial pairing/reconnect/framing tests, safe one-time token lifecycle,
  authenticated identity binding, cancellation-safe teardown, bounded unauthenticated resources,
  and single-session ownership must pass before Desktop stores credentials or opens a listener.
- **Close when:** the reviewed shared commit lands and Desktop pins that reviewed package revision.

### No two-device verification harness

- **Status:** no real Desktop-to-Desktop or Desktop-to-Mobile evidence exists for the current package
  and host seams.
- **Required coverage:** pairing, reconnect, transfer, portable export/import, tamper rejection,
  collisions, disconnect/teardown, and synthetic-profile UI evidence.
- **Order:** Desktop adapters and UI first; Desktop-to-Desktop harness next; Off Grid AI Mobile last;
  Desktop-to-Mobile harness after its native adapters exist.

### Historical sync branches are source material only

- The recovered Claude session `9312c712-e8ad-49d6-8f82-e170d3204472`, branches `feature/sync` and
  `feat/mobile-sync`, and pre-removal snapshots `3bea708` and `8eac748` are not canonical code or
  verification evidence. Port only reviewed pieces into the current `@offgrid/sync` and Desktop host
  contracts. Do not merge a historical branch wholesale.

---

## RESOLVED

### Data-layer / presentation-layer drift sweep (2026-07-09) - CLOSED

Class: the UI kept its own copy of authoritative data instead of binding to the owning source
(hygiene §A). Every TIER-1 item is fixed, behavior-neutral where required, and regression-tested;
the coverage floor held (~97/92/96/98) throughout.

- **T1a. Image composer `imgModel` shadowed the active model** → FIXED. The dropdown's `onChange`
  now writes through the single owner (`MemoryChat.tsx:553` `setActiveModalModel('image', value)`)
  and the composer reads the active value from `imageGenStatus().active` (no latch). Terminal-artifact
  render test: `MemoryChat.image.test.tsx` asserts a dropdown change routes through
  `setActiveModalModel` and reaches the `generateImage` payload.
- **T1b. `imgSteps`/`imgSize` re-seed stomp** → FIXED. Per-model overrides resolved by the pure
  `resolveImageParams`/`setOverride` (`lib/image-params.ts`), persisted via
  `saveSetting('imageParams', …)`; a model change never clobbers a typed value. Render test asserts
  the payload carries the user's steps (10), not the model default (28).
- **T1c. `imgSeed`/`imgNegative`/`imgStrength`/`imgStyle` not persisted** → FIXED. Persisted +
  reloaded through the data layer (`MemoryChat.tsx:314-317, 332-335`). (`imgInit` stays transient -
  a per-turn init-image path, correctly not persisted.)
- **T1d. Image params had no persisted owner** → FIXED (subsumed by T1a–T1c). Image-gen params now
  have a single persisted owner (the settings store); the composer binds to it and writes through.
  A separate Settings > Image editor is optional UX, not a drift bug - descoped, not a gap.
- **T1e. KV cache / FlashAttn / ctxSize two-writer clobber via the mode preset** → FIXED.
  `applyModePreset` (`llm/settings-math.ts`) MERGES - it only fills fields the user has NOT pinned;
  the pinned set (`userExplicit`) is persisted (`llm.ts:194`) and restored on boot (`:125-126`), and
  boot loads the stored `kvCacheType`/`flashAttn` DIRECTLY (never re-derived from the mode), so the
  every-restart re-clobber path is closed too. Tests: `llm/__tests__/settings-merge.test.ts` +
  `kv-launch-roundtrip.test.ts` (persist → restart → launch-args round-trip).
- **T1f. Thinking/reasoning not persisted** → FIXED. Reasoning rides the persisted context blob via
  `buildAssistantContext`/`readReasoning` (`lib/message-persistence.ts`) and is restored on remap.
  Real DB round-trip test: `lib/__tests__/message-persistence.test.ts`.

### TIER 2 (minor / adjacent) - dispositioned

- **Preload `setLlmSettings` type omitted kvCacheType/flashAttn/gpuLayers/threads/batchSize/mode** →
  FIXED (`src/preload/index.ts:244` - the type now carries every field the handler accepts;
  runtime was always passing the whole object, this closes the type-check blind spot).
- **Settings identity fields saved on `blur` only (edit lost if closed without blurring)** → FIXED -
  now also commits on Enter (`Settings.tsx:472-473`), the standard keyboard commit, calling the same
  `saveIdentity`.
- **`ctxSize` halved + persisted by crash recovery (`llm.ts:479-483`)** → BY DESIGN, not a bug. This
  is the deliberate post-crash safety fallback (a too-large KV cache froze macOS on 16GB); it
  intentionally persists a smaller, safe context after a detected crash. Left as-is.
- **VoiceScreen residency toggle fire-and-forget; ActionsScreen prop-resync** → minor UI polish, NOT
  the data-layer drift class (no authoritative copy that diverges). Deferred as cosmetic; would need
  on-device screenshot verification if ever pursued.

### TIER 3 (ephemeral view prefs) - BY DESIGN

ReplayScreen `speed`/`asideW`, ReflectScreen day/week `mode` reset on remount. No authoritative owner
to diverge from - explicitly not the drift class. Persisting them is optional UX, not a gap.

### Reference pattern (correct write-through / refetch-bound)

SettingsPanel (LLM inference controls), ModelPicker (per-modality active model), Projects, Connectors,
ChatDetail, DayView (persisted layout with get + write-back - the good reference), MeetingsScreen,
ReflectScreen, composer chat-prefs (noMemory/tools/connectors/thinking/voice).

### Agentic `generate_image` tool errored (stale keep-alive socket in the tool loop) - CLOSED

**Root cause (verified with in-process DIAG):** the tool loop makes back-to-back requests to
llama-server. Round 0 (`generate_image`) succeeded; round 1's `streamChat` died with `read
ECONNRESET`. Node's global HTTP agent pooled the round-0 socket; llama-server closes its socket after
each response, so the pooled socket was half-closed and round 1's write reset. (The earlier
"modality queue evicts llm mid-loop" hypothesis was DISPROVED - DIAG confirmed the engine stayed
alive; pause was never called.)

**Fix:** every `http.request` to the model uses a fresh connection (`agent: false` +
`Connection: close`); the SSE transport is now one shared `streamCompletion` (`llm/stream.ts`) used
by both `chatStream` and `streamChat`. Regression guards: `__tests__/llm-http-no-keepalive.test.ts`
(reads the source, asserts no keep-alive pool) + `llm/__tests__/stream.test.ts` (a real local SSE
server exercises content/reasoning/tool-calls/abort/timeout). The double intent-decision that could
route "draw …" away from the tool was also closed (`shouldAutoRouteImage` suppresses the renderer
auto-route when the agentic path owns the turn; `image-intent.test.ts` + `MemoryChat.image.test.tsx`
assert tools-ON → `toolChat`, not a direct `generateImage`).
