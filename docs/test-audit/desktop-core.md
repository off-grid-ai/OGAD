# Desktop core: non-mockist tests

The release's 19 core test files. Each one now fakes only a boundary: an executable, the network, the disk, the clock, a RAM or GPU probe, Electron, a browser global, or a third-party native library. Our own modules run for real. Data enters through the app's own write paths.

**Guard:** [`src/main/__tests__/no-mocks-of-our-code.test.ts`](../../src/main/__tests__/no-mocks-of-our-code.test.ts). It runs in PR CI's test gate. The rule and the boundary allow-list are in [`mock-guard.ts`](../../src/main/__tests__/mock-guard.ts). A test may not `vi.mock` or `vi.doMock` a relative, `@offgrid/`, `@renderer/`, `@/` or `src/` path. It may not `vi.spyOn` a name imported from one either. Files written before the rule are listed in [`mock-baseline.json`](../../src/main/__tests__/mock-baseline.json) with their counts. A new mock fails the test, and so does a fixed file that is still listed. The list only shrinks.

**Shared fakes:**
- [`harness/fake-llama-engine.ts`](../../src/main/__tests__/harness/fake-llama-engine.ts): a real llama-server executable. A test can hold its load, make it run out of memory, script its replies and count its launches.
- [`harness/fake-download-host.ts`](../../src/main/__tests__/harness/fake-download-host.ts): a loopback HTTP host with real Range semantics. The fixed https origin is routed to it.

**Run locally under Electron's Node.** The SQLite addon in node_modules is built for Electron's ABI. CI rebuilds it for Node before the test gate.

```bash
E=$(node -p 'require("electron")'); OFFGRID_DATA_DIR=$(mktemp -d) ELECTRON_RUN_AS_NODE=1 arch -arm64 "$E" ./node_modules/vitest/vitest.mjs run --project product-integration --maxWorkers=2 <files>
```

| File | Fakes now (boundary only) | Proves |
|---|---|---|
| `e2e/web-task-sticky-header.spec.ts` | Paired browser (fake extension); a llama-server fixture executable | Earlier tasks finish through the real chat and task loop, with no `INSERT`. The running task's header stays pinned with Stop in view while the panel scrolls. Stop ends the task. |
| `src/main/__tests__/computer-use-capture-exclusion.integration.test.ts` | Electron; `process.platform` | No change needed: already boundary-only |
| `src/main/__tests__/embedding-setup-download.test.ts` | Network: Hugging Face is a local host | Catalog bytes and install state are real. A cancelled download sends no request. An uncancelled one reaches the host. |
| `src/main/__tests__/embeddings-core.test.ts` | `@huggingface/transformers` | Embeddings load from a scan folder while the chosen folder is offline. The package is read-only: no remote fetch and no cache write. |
| `src/main/__tests__/engine-resume-health.test.ts` | Electron; console | No change needed: already boundary-only |
| `src/main/__tests__/llm-eviction.test.ts` | A llama-server executable; the OS ignoring signals (one case); the clock | Eviction resolves only after the engine process has exited. A paused engine refuses chat and does not respawn until release. An engine that will not die refuses image admission. |
| `src/main/__tests__/performance-pack.test.ts` | Kernel `/dev/nvidia*` and `/proc/driver/nvidia/version`; a local download host (Range, 416, wrong range); a `llama-server --list-devices` script | Real runtime config and disk. Offer rules (arch, manifest host, driver, driver floor). Install, resume, restart after 416, oversize partial, hash and library checks, GPU start. |
| `src/main/__tests__/sd-server-fallback.test.ts` | sd-server executables | The real ladder moves to the next engine when one cannot load. Stop ends the ladder. The loaded server is reused for the same model and cleared on a crash. All engines failing reports the last error. |
| `src/main/__tests__/shutdown-registry.test.ts` | console | No change needed: already boundary-only |
| `src/main/__tests__/tts-onnx-worker.test.ts` | `kokoro-js`; `@huggingface/transformers` env; the helper's parent port | The real device ladder: a GPU provider failure falls back to CPU. When every provider fails, it reports an error, and the next request retries. |
| `src/main/__tests__/tts-onnx.test.ts` | Electron `utilityProcess`; the built worker file's presence | Real settings in a temp profile. Device and progress per request. A crash starts a new helper. |
| `src/main/accessibility/__tests__/decision-runtime.test.ts` | llama-server and Kev Python server executables; model files on disk | Real catalog, artifacts, ports and ladder. Start, reuse, decide, health and stop. A missing model, held ports and a missing engine. Kev 4B and 9B use their own checkpoint and base. An invalid Kev reply is refused. Out of memory is classified. |
| `src/main/backup/__tests__/data-port.test.ts` | Electron keychain (none) | The app's real database and schema. Seeding goes through createProject, insertRagDocument, the document store, conversations, messages and restores. Export, restore and round trip behave as before. |
| `src/main/llm/__tests__/model-switch.integration.test.ts` | A llama-server executable | A switch during a load waits for it, then starts one fresh engine. A cancelled load does not try the CPU engine after it. |
| `src/main/llm/__tests__/resource-mode.integration.test.ts` | `os.totalmem` | No change needed: already boundary-only |
| `src/main/models/__tests__/model-integrity.integration.test.ts` | `fs.createWriteStream` fault | No change needed: already boundary-only |
| `src/main/tasks/__tests__/task-execution-plan-service.test.ts` | Electron; a llama-server executable | The default planner is the real `llm` singleton. Telemetry is read from the model-call log the app writes, for both success and failure. |
| `src/renderer/src/__tests__/App.navigation.integration.test.tsx` | Preload bridge; `document.visibilityState` | The real Pro renderer activation runs. Notification routes open after it. Action events are never subscribed. |
| `src/renderer/src/components/setup/__tests__/StorageUsage.integration.test.tsx` | `window.confirm` | No change needed: already boundary-only |

## Findings fixed in product code

- **RAG tables were created once per process.** The guard was a process-wide flag, so a reopened or switched profile database never got its tables, and a restore failed with "no such table: projects". The tables are now ensured once per database connection (`src/main/rag/store.ts`).

## Not covered yet

- **The `active-model.json` file in the web-task e2e is still written by hand.** It is product state on disk, not an `INSERT`. It is left for the baseline burn-down.
- **The baseline burn-down (every other core test) is the next batch.** Progress is in `mock-baseline.json`.
