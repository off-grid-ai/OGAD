#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain Node CLI */
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

function normalized(value) {
  return String(value ?? '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function overlap(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  const smaller = Math.min(a.width * a.height, b.width * b.height)
  return smaller > 0 ? (width * height) / smaller : 0
}

export function replayFixture(fixture) {
  const startedAt = performance.now()
  const candidates = fixture.ax.map((element, index) => ({
    id: element.id ?? `ax-${index + 1}`,
    source: 'ax',
    role: element.role,
    label: element.label,
    bounds: element.bounds,
    executable: element.enabled !== false
  }))
  for (const block of fixture.ocr) {
    const match = candidates.find(
      (candidate) =>
        overlap(candidate.bounds, block.bounds) >= 0.45 &&
        normalized(candidate.label) === normalized(block.text)
    )
    if (match) match.source = 'ax+ocr'
    else {
      candidates.push({
        id: block.id ?? `ocr-${candidates.length + 1}`,
        source: 'ocr',
        role: 'visible-text',
        label: block.text,
        bounds: block.bounds,
        executable: false
      })
    }
  }
  const expected = fixture.expectedTargetId
  const selected = fixture.recordedDecision?.candidateId ?? null
  return {
    fixture: fixture.name ?? 'fixture',
    candidateCount: candidates.length,
    targetRecall: expected
      ? Number(candidates.some((candidate) => candidate.id === expected))
      : null,
    decisionCorrect: expected && selected ? Number(expected === selected) : null,
    selectedCandidateId: selected,
    confidence: fixture.recordedDecision?.confidence ?? null,
    timings: {
      ...(fixture.recordedTimings ?? {}),
      replayMs: Number((performance.now() - startedAt).toFixed(3))
    },
    candidates
  }
}

function main() {
  const input = process.argv[2]
  if (!input)
    throw new Error('Usage: node scripts/computer-use-replay.mjs <sanitized-fixture.json>')
  const fixture = JSON.parse(fs.readFileSync(path.resolve(input), 'utf8'))
  process.stdout.write(`${JSON.stringify(replayFixture(fixture), null, 2)}\n`)
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  main()
}
