import { extractJsonObject } from '../json-extract'

export interface WriterInput {
  milestone: string
  field: {
    role: string
    label: string
    placeholder?: string
    value: string
    secure?: boolean
  }
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

export function writerInputIsPrivate(input: WriterInput): boolean {
  if (input.field.secure === true || /SecureTextField/iu.test(input.field.role)) return true
  return /\b(?:password|passcode|pin|one[- ]?time code|verification code|security code|card number|credit card|debit card|cvv|cvc|payment)\b/iu.test(
    `${input.field.label} ${input.field.placeholder ?? ''}`
  )
}

export function compactWriterPrompt(input: WriterInput): string {
  return [
    'Write the shortest safe text that advances the current milestone in the focused field.',
    'Use only the milestone, field context, nearby text, and authoritative guidance below.',
    'For a search field, write only the shortest literal identifying value. Do not copy action words or a generic category word that follows a specific name unless that word is part of the name.',
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
  const json = extractJsonObject(raw)
  if (!json) {
    return { fill: false, text: '', submit: false, refusalReason: 'invalid_result' }
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
    if (!value.fill || !value.text) {
      return { fill: false, text: '', submit: false }
    }
    return { fill: true, text: value.text, submit: value.submit }
  } catch {
    return { fill: false, text: '', submit: false, refusalReason: 'invalid_result' }
  }
}

export function writerValueMatches(expected: string, observed: string): boolean {
  return expected.replace(/\s+/g, ' ').trim() === observed.replace(/\s+/g, ' ').trim()
}
