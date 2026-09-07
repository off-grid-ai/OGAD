import type { FocusedInputTarget } from './focused-input'

export const PRIVATE_INPUT_HANDOFF = 'Enter the private value, then resume'

const PRIVATE_GOAL =
  /\b(password|passcode|credential|sign[ -]?in|log[ -]?in|one[ -]?time(?: code)?|otp|2fa|verification code|security code|pin|api[ _-]?key|access[ _-]?token|auth(?:orization)? token|secret|credit card|debit card|card number|cvv|cvc|payment)\b/i
const EXPLICIT_TOKEN =
  /\b(?:Bearer\s+\S{8,}|(?:sk|pk|ghp|gho|github_pat|xox[baprs]|AIza)[-_][A-Za-z0-9._-]{8,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/i
const NAMED_SECRET =
  /\b(?:password|passcode|api[ _-]?key|access[ _-]?token|secret|authorization)\s*[:=]\s*\S+/i

function luhn(value: string): boolean {
  let sum = 0
  let double = false
  for (let index = value.length - 1; index >= 0; index -= 1) {
    let digit = Number(value[index])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

function containsPaymentCard(content: string): boolean {
  for (const match of content.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = match[0].replace(/\D/g, '')
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) return true
  }
  return false
}

/** Classify only in memory. Callers must never log or persist the supplied content. */
export function isCredentialLikeInput(content: string, goal: string): boolean {
  if (PRIVATE_GOAL.test(goal)) return true
  if (EXPLICIT_TOKEN.test(content) || NAMED_SECRET.test(content)) return true
  return containsPaymentCard(content)
}

export type SecureInputDecision = { kind: 'allow' } | { kind: 'handoff'; reason: string }

export function secureInputDecision(input: {
  content: string
  goal: string
  target: FocusedInputTarget
}): SecureInputDecision {
  if (input.target.state === 'secure' || isCredentialLikeInput(input.content, input.goal)) {
    return { kind: 'handoff', reason: PRIVATE_INPUT_HANDOFF }
  }
  return { kind: 'allow' }
}
