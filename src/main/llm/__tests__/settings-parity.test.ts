/**
 * Settings parity between the gateway's two modes, at the terminal artifact: the argv handed to
 * llama-server. The same person's settings go through the one launch builder in single and in
 * team mode; every flag they chose must reach the engine in both. Team mode may only add the
 * concurrency flags, grow the shared pool, and change the cache type when the person's own choice
 * leaves room for one request at a time.
 */
import { describe, expect, it } from 'vitest'
import { buildLaunchArgs, type LaunchArgsInput } from '../settings-math'
import { llmSlotPlan } from '@offgrid/models'
import { slotInput } from '../settings-math'

/** A dense 8B: 32 layers × 8 KV heads × 128 dims. */
const DENSE8B = { attentionLayers: 32, kvHeads: 8, keyDim: 128, valueDim: 128 }

/** Everything a person can set that reaches llama-server's argv. */
const PERSON: LaunchArgsInput = {
  modelPath: '/models/chat.gguf',
  mmProjPath: '/models/chat-mmproj.gguf',
  port: 8439,
  effectiveCtxSize: 32768,
  gpuLayers: 30,
  flashAttn: true,
  kvCacheType: 'q8_0',
  kvCacheTypeExplicit: true,
  threads: 6,
  batchSize: 1024,
  speculativeDecoding: 'draft',
  speculativeDraftMax: 6,
  draftModelPath: '/models/draft.gguf',
  imageMinTokens: 1024,
  reportModelPlacement: true,
  totalRamBytes: 64 * 1024 ** 3
}

/** Team mode with a memory reading on a Mac, so the pool is sized from memory. */
const TEAM: Partial<LaunchArgsInput> = {
  gatewayMode: 'team',
  slotPlatform: 'apple-unified',
  slotTotalMemoryGb: 64,
  slotFreeMemoryMB: 40_000,
  weightsMB: 6_000,
  kvShape: DENSE8B,
  architecture: 'llama'
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}

/** The person's flags: every argv pair except the ones team mode owns (slots, pool size). */
function personFlags(args: string[]): Record<string, string | true> {
  const owned = new Set(['--parallel', '-c', '--kv-unified', '--metrics'])
  const out: Record<string, string | true> = {}
  for (let i = 0; i < args.length; i++) {
    const name = args[i]!
    if (!name.startsWith('-')) continue
    const value = args[i + 1]
    const takesValue = value !== undefined && !value.startsWith('-')
    if (!owned.has(name)) out[name] = takesValue ? value : true
    if (takesValue) i++
  }
  return out
}

describe('every setting the person chose reaches llama-server in both modes', () => {
  const single = buildLaunchArgs({ ...PERSON, gatewayMode: 'single' })
  const team = buildLaunchArgs({ ...PERSON, ...TEAM })

  it('single mode carries each setting', () => {
    expect(flag(single, '-m')).toBe(PERSON.modelPath)
    expect(flag(single, '--mmproj')).toBe(PERSON.mmProjPath)
    expect(flag(single, '-c')).toBe('32768')
    expect(flag(single, '-ngl')).toBe('30')
    expect(flag(single, '--flash-attn')).toBe('on')
    expect(flag(single, '--cache-type-k')).toBe('q8_0')
    expect(flag(single, '--cache-type-v')).toBe('q8_0')
    expect(flag(single, '-t')).toBe('6')
    expect(flag(single, '-b')).toBe('1024')
    expect(flag(single, '--spec-type')).toBe('draft-simple')
    expect(flag(single, '--spec-draft-model')).toBe('/models/draft.gguf')
    expect(flag(single, '--spec-draft-n-max')).toBe('6')
    expect(flag(single, '--image-min-tokens')).toBe('1024')
    expect(flag(single, '--parallel')).toBe('1')
  })

  it('team mode carries the same settings, adding only its slots and pool', () => {
    expect(personFlags(team)).toEqual(personFlags(single))
    expect(Number(flag(team, '--parallel'))).toBeGreaterThan(1)
    expect(team).toContain('--kv-unified')
    expect(team).toContain('--metrics')
    // One conversation may still use the person's whole context.
    expect(Number(flag(team, '-c'))).toBeGreaterThanOrEqual(32768)
  })

  it('holds for every cache type and speculative mode the person can pick', () => {
    for (const kvCacheType of ['f16', 'q8_0', 'q4_0'] as const)
      for (const speculativeDecoding of ['off', 'ngram', 'mtp', 'draft'] as const) {
        const person = { ...PERSON, kvCacheType, speculativeDecoding }
        expect(personFlags(buildLaunchArgs({ ...person, ...TEAM }))).toEqual(
          personFlags(buildLaunchArgs({ ...person, gatewayMode: 'single' }))
        )
      }
  })

  it('DFlash keeps one slot in team mode, with every setting', () => {
    const person = { ...PERSON, speculativeDecoding: 'dflash' as const }
    const args = buildLaunchArgs({ ...person, ...TEAM })
    expect(flag(args, '--parallel')).toBe('1')
    expect(personFlags(args)).toEqual(
      personFlags(buildLaunchArgs({ ...person, gatewayMode: 'single' }))
    )
  })
})

describe('where team mode may differ, and why', () => {
  it('keeps an explicit f16 cache while it still leaves several slots', () => {
    const person = { ...PERSON, kvCacheType: 'f16' as const, flashAttn: false }
    const args = buildLaunchArgs({ ...person, ...TEAM })
    expect(args).not.toContain('--cache-type-k')
    expect(Number(flag(args, '--parallel'))).toBeGreaterThan(1)
  })

  it('moves an explicit f16 cache to q8_0 only when f16 would leave one slot, and says why', () => {
    const person = { ...PERSON, kvCacheType: 'f16' as const, flashAttn: false }
    // Memory for one f16 conversation of 32K, not for two; q8_0 fits more.
    const tight = { ...TEAM, slotFreeMemoryMB: 11_000 }
    const plan = llmSlotPlan(slotInput({ ...person, ...tight }))
    expect(plan.kv).toEqual({ k: 'q8_0', v: 'q8_0' })
    expect(plan.slots).toBeGreaterThan(1)
    expect(plan.kvNote).toMatch(/one request at a time/)
    const args = buildLaunchArgs({ ...person, ...tight })
    expect(flag(args, '--cache-type-k')).toBe('q8_0')
    // A quantized cache needs flash attention, in either mode.
    expect(flag(args, '--flash-attn')).toBe('on')
  })

  it('a cache type from a default (not chosen) follows the team rule: Gemma stays f16', () => {
    const person = { ...PERSON, kvCacheType: 'q8_0' as const, kvCacheTypeExplicit: false }
    const args = buildLaunchArgs({ ...person, ...TEAM, architecture: 'gemma4' })
    expect(args).not.toContain('--cache-type-k')
    // The person's explicit q8_0 on Gemma is kept.
    const chosen = buildLaunchArgs({
      ...person,
      kvCacheTypeExplicit: true,
      ...TEAM,
      architecture: 'gemma4'
    })
    expect(flag(chosen, '--cache-type-k')).toBe('q8_0')
  })

  it('on CUDA, sizes slots from VRAM by the shared policy and batches wider unless the person set a batch', () => {
    const cuda: Partial<LaunchArgsInput> = {
      gatewayMode: 'team',
      slotPlatform: 'cuda',
      slotTotalMemoryGb: 48,
      slotFreeMemoryMB: 44_000,
      weightsMB: 5_000,
      kvShape: DENSE8B,
      architecture: 'llama'
    }
    const person = {
      ...PERSON,
      effectiveCtxSize: 8192,
      kvCacheType: 'f16' as const,
      batchSize: undefined
    }
    const args = buildLaunchArgs({ ...person, ...cuda })
    expect(flag(args, '--parallel')).toBe(
      String(llmSlotPlan(slotInput({ ...person, ...cuda })).slots)
    )
    expect(flag(args, '--parallel')).toBe('16')
    expect(flag(args, '-b')).toBe('4096')
    expect(flag(args, '-ub')).toBe('1024')
    const own = buildLaunchArgs({ ...person, batchSize: 512, ...cuda })
    expect(flag(own, '-b')).toBe('512')
    expect(own).not.toContain('-ub')
  })
})
