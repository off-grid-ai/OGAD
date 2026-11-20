/**
 * Terminal-artifact regression test for the "explicit KV-cache reverts to f16" bug.
 *
 * The shape test (settings-merge.test.ts) asserts the pure `applyModePreset` return.
 * That is necessary but NOT sufficient (hygiene §D assertion-subject gate): the FEATURE
 * the user cares about is that llama-server actually LAUNCHES with q8_0 after a mode
 * pick AND after an app restart. The terminal artifact is the LAUNCH ARGS — what really
 * gets passed to the engine — reached through the REAL persist→reload path, not a merge
 * function's return value.
 *
 * This drives the whole round-trip against a REAL temp settings file (OFFGRID_DATA_DIR
 * points `modelsDir()` at a mkdtemp dir, so persist() writes and the constructor reads
 * the same JSON on disk — no stubs):
 *   (a) user sets kvCacheType='q8_0' → pins + persists
 *   (b) apply performanceMode='balanced' (the mode preset that carries f16)
 *   (c) RESTART — a fresh LLMService whose constructor re-reads the persisted file
 *   (d) build the launch args from the reloaded instance
 *   (e) assert the args contain '--cache-type-k','q8_0' and '--flash-attn','on' — NOT f16
 *
 * Litmus (red-capable by a DIFFERENT mechanism than the merge line): this fails if
 * persist() drops the pin-set, if the constructor doesn't reload kvCacheType/pins, or
 * if the arg-builder ignores the KV setting — not only if applyModePreset regresses.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { LLMService, LlmSettings } from '../../llm'

// Assert on the actual argv slots, not just "includes 'q8_0'": a `--cache-type-k q8_0`
// pair is the real launch contract. Helper finds the value that follows a flag.
function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

describe('KV-cache launch-args round-trip (persist → restart → launch)', () => {
  let dataDir: string
  const prevDataDir = process.env.OFFGRID_DATA_DIR

  beforeEach(() => {
    // Real temp dir → real settings file on disk (mirrors the vault-service.test.ts /
    // database-integration.dbtest.ts temp-dir pattern).
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-kv-'))
    fs.mkdirSync(path.join(dataDir, 'models'), { recursive: true })
    process.env.OFFGRID_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (prevDataDir === undefined) {
      delete process.env.OFFGRID_DATA_DIR
    } else {
      process.env.OFFGRID_DATA_DIR = prevDataDir
    }
    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  // Fresh module instance per test so each LLMService reads the current env/dir.
  async function freshService(): Promise<LLMService> {
    const mod = await import('../../llm')
    return new mod.LLMService()
  }

  // setSettings respawns on a launch-arg change; with no gguf in the temp dir the
  // respawn's init() rejects with "No chat model yet." AFTER persist() has already
  // written — so swallow that expected rejection; the persisted round-trip is intact.
  async function applySettings(svc: LLMService, s: LlmSettings): Promise<void> {
    await svc.setSettings(s).catch(() => {})
  }

  it('q8_0 pinned → balanced mode → RESTART still launches with q8_0 + flash-attn on (not f16)', async () => {
    // (a) user pins q8_0 granularly
    const first = await freshService()
    await applySettings(first, { kvCacheType: 'q8_0' })
    // (b) then picks a performance mode whose preset is f16 (the clobber the bug caused)
    await applySettings(first, { performanceMode: 'balanced' })

    // The persisted file must carry BOTH the value AND the pin-set — the round-trip
    // relies on it, so assert the on-disk contract directly.
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'models', 'llm-settings.json'), 'utf-8')
    )
    expect(persisted.kvCacheType).toBe('q8_0')
    expect(persisted.userExplicit).toContain('kvCacheType')

    // (c) RESTART: a brand-new service whose constructor re-reads the persisted file.
    const restarted = await freshService()

    // (d)+(e) the TERMINAL ARTIFACT: the argv handed to llama-server after the restart.
    const args = restarted.launchArgs()
    expect(argValue(args, '--cache-type-k')).toBe('q8_0')
    expect(argValue(args, '--cache-type-v')).toBe('q8_0')
    expect(argValue(args, '--flash-attn')).toBe('on')
    // Belt-and-braces: f16 never leaks into the KV flags.
    expect(args).not.toContain('f16')
  })

  it('no pin: conservative → balanced mode → RESTART launches with f16 (no KV flags) — the intended default', async () => {
    // A user who never pinned KV: the mode preset is the source of truth. Go through
    // conservative (q8_0) first so the balanced switch has to actually flip KV back to
    // f16 — an unpinned field follows the mode all the way through the reload.
    const first = await freshService()
    await applySettings(first, { performanceMode: 'conservative' })
    await applySettings(first, { performanceMode: 'balanced' })

    const restarted = await freshService()
    const args = restarted.launchArgs()
    // balanced = f16 → no --cache-type-k/-v at all, and flash-attn stays off.
    expect(args).not.toContain('--cache-type-k')
    expect(args).not.toContain('--cache-type-v')
    expect(args).not.toContain('--flash-attn')
  })

  it('conservative mode (preset q8_0) with no pin → RESTART launches with q8_0', async () => {
    // Guards that the reload path carries a preset-derived (not user-pinned) q8_0 too.
    const first = await freshService()
    await applySettings(first, { performanceMode: 'conservative' })

    const restarted = await freshService()
    const args = restarted.launchArgs()
    expect(argValue(args, '--cache-type-k')).toBe('q8_0')
    expect(argValue(args, '--flash-attn')).toBe('on')
  })
})
