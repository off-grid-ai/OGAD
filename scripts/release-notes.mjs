#!/usr/bin/env node
// Build consumer-facing release notes from conventional-commit subjects.
//
// Usage:
//   node scripts/release-notes.mjs <prevTag> <version> <repo> [toRef]
//   - prevTag: previous release tag, or "" for the first release
//   - version: the version being released, WITHOUT the leading "v" (e.g. 0.0.33)
//   - repo:    owner/name (for the Full Changelog compare link)
//   - toRef:   end of the range (default HEAD). CI omits it; backfill passes the
//              tag being documented (e.g. v0.0.25) so it reads prevTag..v0.0.25.
//
// Reads `git log <prevTag>..HEAD` itself, so it is the single source of truth for
// both the CI step and the backfill. Output goes to stdout (the workflow redirects
// it to release-notes.md). No network, no API key, deterministic.
//
// Shape:
//   ## Highlights         <- the human-readable summary (grouped, plain language)
//   **New** / **Fixes**
//   ## What's Changed     <- the full commit list (same as before)
//   **Full Changelog**: …

import { execFileSync } from 'node:child_process'

const [prevTag = '', version = '0.0.0', repo = '', toRef = 'HEAD'] = process.argv.slice(2)

// Commit types that mean something to a person using the app. Everything else
// (chore, ci, docs, test, refactor, style, build, wip, snapshot) is internal and
// stays out of the human summary - it still shows in the raw commit list below.
const TYPE_GROUP = { feat: 'New', fix: 'Fixes', perf: 'Fixes' }

// Pass args to git directly (no shell) so the range/refs are never interpreted as
// command text. %s subject, %h short hash, tab-separated. Skip the bot version bump.
const range = prevTag ? `${prevTag}..${toRef}` : toRef
const raw = execFileSync(
  'git',
  ['log', range, '--no-merges', '--invert-grep', '--grep=\\[skip ci\\]', '--pretty=format:%s\t%h'],
  { encoding: 'utf8' }
).trim()

const commits = raw
  ? raw.split('\n').map((l) => {
      const [subject, hash] = l.split('\t')
      return { subject, hash }
    })
  : []

const releaseNotes = {
  // Turn a conventional-commit subject into a plain sentence a user can read.
  // stripType: drop a conventional "type:" prefix. Plain subjects keep theirs ("iOS:", "Ask:").
  humanize(subject, stripType = true) {
    const match = stripType && subject.match(/^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/)
    let text = match ? match[3] : subject
    text = text
      .replace(/\s*\(#\d+\)\s*$/, '') // drop trailing PR refs: "(#11)"
      .replace(/[—–]/g, ' - ') // em/en dash -> " - " (brand voice)
      .replace(/[‘’]/g, "'") // curly -> straight
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
    return text.charAt(0).toUpperCase() + text.slice(1)
  },
  typeOf(subject) {
    const match = subject.match(/^(\w+)(?:\([^)]+\))?!?:/)
    return match ? match[1] : null
  }
}

// Most subjects are plain outcome sentences now, not "feat:"/"fix:", and a pro change arrives as
// "Pin pro <sha>: <what changed>". Read those too, so a build full of changes never says it has
// none. A subject about tests, CI, docs or the review tooling stays out of the summary.
const INTERNAL =
  /\b(e2e|tests|unit tests?|test suite|spec|fixtures?|CI|lint|typecheck|README|docs?|change review|change-map|cache[sd]?|engine pins?|hooks?|refactor|chore)\b/i
// Conventional types that are internal. Any other "Word:" prefix ("Pro:", "Ask:") is a plain
// subject naming the feature it changes.
const INTERNAL_TYPES = new Set([
  'chore',
  'ci',
  'docs',
  'test',
  'refactor',
  'style',
  'build',
  'wip',
  'snapshot'
])
const PIN = /^(?:pin\s+)?(?:pro|operator-ui)(?:\s+pointer)?(?:\s+[0-9a-f]{7,40})?\s*:\s*/i
function plainChange(subject) {
  if (/^merge\b/i.test(subject) || /^(bump|release)\b/i.test(subject)) return null
  const text = subject.replace(PIN, '').replace(/^what it does for you:\s*/i, '')
  // A subject that opens with a code name (useAppTheme, gpuDeviceAvailable) is about the code.
  if (
    !text ||
    /^pin\s+(?:[0-9a-f]{7,40}|pro|operator-ui)\b/i.test(text) ||
    /^(?!(?:macOS|iOS|iPadOS|watchOS|visionOS)\b)[a-z]+[A-Z]\w*\b/.test(text) ||
    INTERNAL.test(text)
  )
    return null
  return releaseNotes.humanize(text.replace(/^pro:\s*/i, ''), false)
}

// Group the user-facing commits.
const groups = { New: [], Fixes: [], Changes: [] }
for (const c of commits) {
  const group = TYPE_GROUP[releaseNotes.typeOf(c.subject)]
  if (group) {
    groups[group].push(releaseNotes.humanize(c.subject))
  } else if (!INTERNAL_TYPES.has(releaseNotes.typeOf(c.subject))) {
    const line = plainChange(c.subject)
    if (line) groups.Changes.push(line)
  }
}

// De-dupe within a group (snapshots/rebases can repeat a subject).
for (const k of Object.keys(groups)) groups[k] = [...new Set(groups[k])]

const out = []
out.push('## Highlights', '')

const hasHighlights = groups.New.length || groups.Fixes.length || groups.Changes.length
if (hasHighlights) {
  if (groups.New.length) {
    out.push('**New**', '')
    for (const line of groups.New) out.push(`- ${line}`)
    out.push('')
  }
  if (groups.Fixes.length) {
    out.push('**Fixes**', '')
    for (const line of groups.Fixes) out.push(`- ${line}`)
    out.push('')
  }
  if (groups.Changes.length) {
    out.push('**Changes**', '')
    for (const line of groups.Changes) out.push(`- ${line}`)
    out.push('')
  }
} else {
  // Only internal commits (chore/ci/docs/test). Be honest about it.
  out.push('Maintenance release. No user-facing changes this build.', '')
}

out.push("## What's Changed", '')
if (commits.length) {
  for (const c of commits) out.push(`- ${c.subject} (${c.hash})`)
} else {
  out.push('- No changes since the previous release.')
}
out.push('')
// On the first release there's no prior tag to compare against (a v0.0.0 compare
// link would 404), so point at the release tag itself.
if (prevTag) {
  out.push(`**Full Changelog**: https://github.com/${repo}/compare/${prevTag}...v${version}`)
} else {
  out.push(`**Full Changelog**: https://github.com/${repo}/releases/tag/v${version}`)
}

process.stdout.write(out.join('\n') + '\n')
