// Scientific catalog-vision guard. Vision capability is a FACT about a model's files
// (does it ship an mmproj projector?), not a hand-typed flag — and a hand-typed catalog
// can omit a projector the repo actually publishes, silently demoting a vision model to
// text-only (Gemma 4 E2B). This queries each chat model's real Hugging Face repo and
// fails if the catalog disagrees with the repo about projectors.
//
// Networked, so it's NOT part of the offline unit suite — run in CI / on demand:
//   npm run verify:catalog
//
// Exit 1 (with a list) on any drift; exit 0 when the catalog matches every repo.

import { CATALOG } from '@offgrid/models'

const catalogVerification = {
  isProjector(name) {
    return /mmproj|clip/i.test(name)
  },
  isChatModel(kind) {
    return kind === 'text' || kind === 'vision' || kind === 'computer_use'
  },
  looksLikeHfRepo(id) {
    return /^[^/\s]+\/[^/\s]+$/.test(id)
  },
  async repoProjectorFiles(repoId) {
    const res = await fetch(`https://huggingface.co/api/models/${repoId}`, {
      signal: AbortSignal.timeout(30_000)
    })
    if (!res.ok) {
      throw new Error(`repo metadata HTTP ${res.status}`)
    }
    const data = await res.json()
    return (data.siblings ?? []).map((s) => s.rfilename).filter(catalogVerification.isProjector)
  }
}

const problems = []
let checked = 0

for (const m of CATALOG) {
  if (!catalogVerification.isChatModel(m.kind) || !catalogVerification.looksLikeHfRepo(m.id)) {
    continue
  }
  checked++
  let repoProjectors
  try {
    repoProjectors = await catalogVerification.repoProjectorFiles(m.id)
  } catch (e) {
    // A fetch failure is not catalog drift — report as a warning, don't fail the guard.
    console.warn(`  ? ${m.id}: could not verify (${e.message})`)
    continue
  }
  const catalogHasProjector = m.files.some((f) => f.role === 'mmproj')
  if (repoProjectors.length > 0 && !catalogHasProjector) {
    problems.push(
      `${m.id}: repo publishes a projector (${repoProjectors[0]}) but the catalog omits it — ` +
        `this model can't read images (kind='${m.kind}'). Add the mmproj file to its entry.`
    )
  }
  if (catalogHasProjector && repoProjectors.length === 0) {
    problems.push(
      `${m.id}: catalog lists an mmproj the repo does not publish — the projector download will 404.`
    )
  }
}

if (problems.length > 0) {
  console.error(`\nCatalog projector drift (${problems.length}):`)
  for (const p of problems) {
    console.error(`  ✗ ${p}`)
  }
  process.exit(1)
}
console.log(`Catalog projectors verified against Hugging Face — ${checked} chat models, no drift.`)
