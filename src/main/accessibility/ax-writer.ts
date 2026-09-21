import { extractJsonObject } from '../json-extract'

export interface WriterInput {
  milestone: string
  field: { role: string; label: string; placeholder?: string; value: string }
  nearbyText: readonly string[]
  recentActionResult?: string
  guidance: readonly string[]
}

export interface WriterResult {
  fill: boolean
  text: string
  submit: boolean
  refusalReason?: string
}

const PRIVATE_FIELD =
  /password|passcode|one[- ]?time|otp|verification code|card|cvv|cvc|payment|bank|routing|secret|private/i

export function writerInputIsPrivate(input: WriterInput): boolean {
  return PRIVATE_FIELD.test(
    `${input.field.role} ${input.field.label} ${input.field.placeholder ?? ''} ${input.milestone}`
  )
}

export function deterministicWriterLiteral(input: WriterInput): string | undefined {
  const quoted = /[`“”"]([^`“”"]{1,160})[`“”"]/u.exec(input.milestone)?.[1]?.trim()
  if (quoted) return quoted
  const url = /\bhttps?:\/\/[^\s]+/iu.exec(input.milestone)?.[0]
  if (url) return url.replace(/[),.;!?]+$/u, '')
  const identifiers = Array.from(
    new Set(input.milestone.match(/\b[A-Z][A-Z0-9._-]{1,15}\b/gu) ?? [])
  ).filter((value) => !['AX', 'OCR', 'UI'].includes(value))
  return identifiers.length === 1 ? identifiers[0] : undefined
}

export function compactWriterPrompt(input: WriterInput): string {
  return [
    'Write the shortest safe text that advances the current milestone in the focused field.',
    'Use only the milestone, field context, nearby text, and authoritative guidance below.',
    'For a search field, write only the shortest literal identifying value. Do not copy action words or a generic category word that follows a specific name unless that word is part of the name.',
    'When the current search has no matches, replace it with a shorter identifying value from the milestone.',
    'Set fill=false for passwords, codes, payment data, private data, or when the text is not known.',
    'When you return non-empty text, you must set fill=true.',
    'Set submit=true only when the completed field should be submitted now.',
    JSON.stringify({
      milestone: input.milestone.slice(0, 500),
      field: {
        role: input.field.role.slice(0, 80),
        label: input.field.label.slice(0, 160),
        placeholder: input.field.placeholder?.slice(0, 160),
        value: input.field.value.slice(0, 500)
      },
      nearbyText: input.nearbyText.slice(0, 12).map((text) => text.slice(0, 240)),
      recentActionResult: input.recentActionResult?.slice(0, 500),
      guidance: input.guidance.slice(-4).map((text) => text.slice(0, 500)),
      response: { fill: 'boolean', text: 'string', submit: 'boolean' }
    })
  ].join('\n')
}

export function parseWriterResult(raw: string, input: WriterInput): WriterResult {
  if (writerInputIsPrivate(input)) {
    return { fill: false, text: '', submit: false, refusalReason: 'private_field' }
  }
  const literal = deterministicWriterLiteral(input)
  const json = extractJsonObject(raw)
  if (!json) {
    return literal
      ? { fill: true, text: literal, submit: false }
      : { fill: false, text: '', submit: false, refusalReason: 'invalid_result' }
  }
  try {
    const value = JSON.parse(json) as Record<string, unknown>
    if (
      typeof value.fill !== 'boolean' ||
      typeof value.text !== 'string' ||
      typeof value.submit !== 'boolean'
    ) {
      return { fill: false, text: '', submit: false, refusalReason: 'invalid_result' }
    }
    const failedSearch = /\b(?:no matches|no results|0 of|zero results)\b/iu.test(
      input.recentActionResult ?? ''
    )
    const current = input.field.value.replace(/\s+/g, ' ').trim()
    const proposed = value.text.replace(/\s+/g, ' ').trim()
    if (failedSearch && (!value.fill || !proposed || proposed === current)) {
      const words = current.split(' ').filter(Boolean)
      if (words.length > 1) {
        return { fill: true, text: words.slice(0, -1).join(' '), submit: value.submit }
      }
    }
    if (!value.fill || !value.text) {
      return literal
        ? { fill: true, text: literal, submit: false }
        : { fill: false, text: '', submit: false }
    }
    return { fill: true, text: value.text, submit: value.submit }
  } catch {
    return literal
      ? { fill: true, text: literal, submit: false }
      : { fill: false, text: '', submit: false, refusalReason: 'invalid_result' }
  }
}

export function writerValueMatches(expected: string, observed: string): boolean {
  return expected.replace(/\s+/g, ' ').trim() === observed.replace(/\s+/g, ' ').trim()
}
