/**
 * Regression guard for the Windows image-gen "binary not found" bug.
 *
 * scripts/fetch-win-binaries.ps1 populates resources/bin/sd/sd-cli.exe from an
 * upstream stable-diffusion.cpp release asset, matched by NAME. The sd fetch is
 * OPTIONAL (the script's verify block only WARNs when sd-cli.exe is missing), so
 * a stale asset pattern fails SILENTLY at build time: `Get-AssetUrl` throws "no
 * asset matching", the try/catch swallows it into a warning, and the Windows
 * package ships with NO image binary — surfacing only at runtime as
 *   "Image generation binary (sd-cli) not found in resources/bin/sd."
 * (src/main/imagegen.ts:findSdCli -> throw).
 *
 * That is exactly what happened: upstream retired `bin-win-avx2-x64.zip`. This
 * test fails if the script ever references that dead asset again, and asserts it
 * matches a currently-published Windows asset instead.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SCRIPT = path.resolve(process.cwd(), 'scripts/fetch-win-binaries.ps1')
const SRC = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, 'utf-8') : ''

describe.skipIf(!SRC)('fetch-win-binaries.ps1 — stable-diffusion.cpp asset', () => {
  it('does not FETCH the retired avx2 Windows asset', () => {
    // Upstream no longer publishes this name; matching it fetches nothing. The
    // name may still appear in a comment (documenting the breakage) — what must
    // never come back is an active Expand-Asset call against it.
    const activeAvx2 = SRC.split(/\r?\n/).some(
      (line) => /Expand-Asset/.test(line) && /avx2/.test(line) && !/^\s*#/.test(line)
    )
    expect(activeAvx2).toBe(false)
  })

  it('fetches the Vulkan (GPU) sd build as the primary into bin/sd', () => {
    // feat/win-gpu-imagegen: the GPU build is primary so Windows image gen runs on
    // the GPU (mirrors the llama bin/llama Vulkan primary). sd-bin.ts resolves sd/ first.
    expect(SRC).toMatch(/leejet\/stable-diffusion\.cpp'\s+'bin-win-vulkan-x64\\\.zip\$'/)
    expect(SRC).toMatch(/Copy-Runtime \$x 'sd'/)
  })

  it('still fetches the CPU sd build as the fallback into bin/sd-cpu', () => {
    // CPU fallback for a box with no Vulkan loader (mirrors llama bin/llama-cpu).
    expect(SRC).toMatch(/leejet\/stable-diffusion\.cpp'\s+'bin-win-cpu-x64\\\.zip\$'/)
    expect(SRC).toMatch(/Copy-Runtime \$x 'sd-cpu'/)
  })

  it('still renames upstream sd.exe to the sd-cli.exe the app resolves', () => {
    // imagegen.ts / sd-server.ts resolve resources/bin/sd/sd-cli(.exe); upstream
    // ships it as sd.exe, so the rename must stay or the resolver misses it.
    expect(SRC).toMatch(/sd-cli\.exe/)
    expect(SRC).toMatch(/Copy-Item \$sd \$cli -Force/)
  })

  it('keeps sd-cli.exe in the post-fetch verify (present, even if only a warning)', () => {
    expect(SRC).toMatch(/'sd\\sd-cli\.exe'/)
  })
})
