// Seeded random numbers, so every generated page and task can be rebuilt from its seed.

export function createRng(seed) {
  let state = hashSeed(String(seed))
  const next = () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const int = (min, max) => min + Math.floor(next() * (max - min + 1))
  const pick = (items) => items[Math.floor(next() * items.length)]
  const chance = (p) => next() < p
  const shuffle = (items) => {
    const copy = [...items]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1))
      ;[copy[i], copy[j]] = [copy[j], copy[i]]
    }
    return copy
  }
  const sample = (items, count) => shuffle(items).slice(0, count)
  return { next, int, pick, chance, shuffle, sample }
}

function hashSeed(text) {
  let h = 1779033703 ^ text.length
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  return h >>> 0
}
