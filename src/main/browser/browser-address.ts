/** Convert what the user enters in the address field to a safe web URL. */
export function normalizeBrowserAddress(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
    } catch {
      return null
    }
  }
  if (!/\s/.test(value) && value.includes('.')) {
    try {
      return new URL(`https://${value}`).toString()
    } catch {
      return null
    }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

/** Use an address that the user wrote explicitly. */
export function explicitBrowserAddress(goal: string): string | null {
  const match = goal.match(
    /\b(?:https?:\/\/)?(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.[a-z]{2,}(?:\/[^\s,;]*)?/i
  )
  return match ? normalizeBrowserAddress(match[0].replace(/[.)!?]+$/, '')) : null
}
