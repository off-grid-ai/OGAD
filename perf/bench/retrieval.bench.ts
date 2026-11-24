// Hot paths of search and retrieval in shared code (@offgrid/rag), measured with fixed, seeded data
// so two runs compare the same work. perf/bench-gate.mjs turns the results into the per-PR gate.
//
// "calibration" is not product code: it is a fixed CPU workload every other result is divided by, so
// the committed baseline still compares on a faster or slower machine (a CI runner, a laptop).
import { bench, describe } from 'vitest'
import { fuseRankings, rankByVector, splitPages, type RankedPassage } from '@offgrid/rag/documents'
import {
  calibrate,
  ftsQuery,
  Int8Index,
  jaccard,
  mmr,
  normaliseForIndex,
  parseTimeWindow,
  wordSet
} from '@offgrid/rag/records'

const DIMENSIONS = 384
// Long enough per benchmark that a median is steady on a busy machine.
const options = { time: 1500, warmupTime: 300 }

// mulberry32: a tiny seeded PRNG, so the data is the same on every run.
const random = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const next = random(42)

const unitVector = (): Float32Array => {
  const v = new Float32Array(DIMENSIONS)
  let norm = 0
  for (let i = 0; i < DIMENSIONS; i++) {
    v[i] = next() * 2 - 1
    norm += v[i]! * v[i]!
  }
  norm = Math.sqrt(norm)
  for (let i = 0; i < DIMENSIONS; i++) v[i] = v[i]! / norm
  return v
}

const WORDS =
  'meeting notes budget launch review design invoice travel doctor school contract release model ' +
  'privacy offline search memory timeline project roadmap customer support पैसा बैठक यात्रा परियोजना'
const vocabulary = WORDS.split(' ')
const sentence = (words: number): string =>
  Array.from({ length: words }, () => vocabulary[Math.floor(next() * vocabulary.length)]).join(' ')

// Records: 20,000 screen moments, meetings and notes, as a year of use builds up.
const recordVectors = Array.from({ length: 20_000 }, unitVector)
const recordIndex = new Int8Index(DIMENSIONS, calibrate(recordVectors.slice(0, 500), DIMENSIONS))
recordVectors.forEach((vector, i) => recordIndex.add(`record:${i}`, vector))

// Documents: 5,000 passages of chat attachments and knowledge bases.
const passageVectors = new Map<string, Float32Array>()
for (let i = 0; i < 5_000; i++) passageVectors.set(`doc${i % 50}:${i}`, unitVector())
const query = Array.from(unitVector())

const keywordHits = Array.from({ length: 200 }, (_, i) => ({
  documentId: `doc${i % 50}`,
  position: i * 7,
  score: 200 - i
}))
const vectorHits: RankedPassage[] = rankByVector(query, passageVectors, 200)

const candidates = Array.from({ length: 120 }, (_, i) => ({
  text: sentence(40),
  score: 1 - i / 120
}))
const candidateWords = new Map(candidates.map((c) => [c, wordSet(c.text)]))

const questions = [
  'what did we decide about the budget last week',
  'meetings with the design team yesterday afternoon',
  'invoices from march',
  'what was I working on two days ago',
  'notes from the launch review on monday',
  'पिछले हफ्ते की बैठक'
]
const indexTexts = Array.from({ length: 200 }, () => sentence(60))

const pages = Array.from({ length: 100 }, (_, i) => ({
  page: i + 1,
  text: Array.from({ length: 12 }, () => sentence(30) + '.').join('\n')
}))

const calibrationData = Array.from({ length: 4_000 }, () => next())

describe('calibration', () => {
  bench(
    'fixed CPU workload',
    () => {
      // A mix of what the benches below do: float maths, a sort and string work.
      const copy = calibrationData.slice()
      copy.sort((a, b) => a - b)
      let dot = 0
      for (let i = 0; i < copy.length; i++) dot += copy[i]! * calibrationData[i]!
      const text = vocabulary.join(' ').repeat(4)
      let count = 0
      for (const word of text.split(' ')) if (word.length > 5) count++
      if (dot < 0 || count < 0) throw new Error('unreachable')
    },
    options
  )
})

describe('records', () => {
  bench(
    'int8 vector search, 20k records',
    () => {
      recordIndex.search(query, 20)
    },
    options
  )
  bench(
    'MMR diversify 120 candidates to 12',
    () => {
      mmr(
        candidates,
        (c) => c.score,
        (a, b) => {
          const left = candidateWords.get(a)!
          const right = candidateWords.get(b)!
          let shared = 0
          for (const w of left) if (right.has(w)) shared++
          return shared / (left.size + right.size - shared || 1)
        },
        12
      )
    },
    options
  )
  bench(
    'jaccard on two passages',
    () => {
      jaccard(candidates[0]!.text, candidates[1]!.text)
    },
    options
  )
  bench(
    'parse time phrases in 6 questions',
    () => {
      for (const q of questions) parseTimeWindow(q, 1_763_700_000_000)
    },
    options
  )
  bench(
    'normalise + FTS query for 200 texts',
    () => {
      for (const text of indexTexts) {
        normaliseForIndex(text)
        ftsQuery(text.slice(0, 80))
      }
    },
    options
  )
})

describe('documents', () => {
  bench(
    'rank 5k passages by vector',
    () => {
      rankByVector(query, passageVectors, 40)
    },
    options
  )
  bench(
    'fuse 200 keyword + 200 vector hits',
    () => {
      fuseRankings('budget launch review', keywordHits, vectorHits)
    },
    options
  )
  bench(
    'split a 100-page document into passages',
    async () => {
      await splitPages('doc', 'pdf', pages)
    },
    options
  )
})
