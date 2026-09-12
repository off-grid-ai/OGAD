import type { ParseResult } from './types'

type MessageRole = 'user' | 'assistant'

interface RoleLabel {
  role: MessageRole
  remainder?: string
}

interface RoleLabelDefinition {
  label: string
  role: MessageRole
}

interface NoiseFilterOptions {
  literals: readonly string[]
  prefixes?: readonly string[]
  patterns?: readonly RegExp[]
}

interface TaggedChatParserConfig {
  detectRoleLabel?: (value: string) => RoleLabel | null
  isNoiseLine?: (value: string) => boolean
}

interface TaggedChatMetadata {
  browserUrl?: string
  chatTitle?: string
  lastTimestamp: string
  windowTitle?: string
}

const keepLine = (): boolean => false

function consumeMetadataLine(trimmed: string, metadata: TaggedChatMetadata): boolean {
  if (trimmed.startsWith('[WINDOW_TITLE]')) {
    metadata.windowTitle = trimmed.replace('[WINDOW_TITLE]', '').trim()
    return true
  }
  if (trimmed.startsWith('[BROWSER_URL]')) {
    metadata.browserUrl = trimmed.replace('[BROWSER_URL]', '').trim()
    return true
  }
  if (trimmed.startsWith('[CHAT_TITLE]')) {
    metadata.chatTitle = trimmed.replace('[CHAT_TITLE]', '').trim()
    return true
  }
  if (trimmed.startsWith('[TITLE]')) {
    return true
  }
  if (trimmed.startsWith('[METADATA]')) {
    const time = trimmed.replace('[METADATA]', '').trim()
    if (/\d{1,2}:\d{2}/.test(time)) {
      metadata.lastTimestamp = time
    }
    return true
  }
  return false
}

export function createNoiseFilter({
  literals,
  prefixes = [],
  patterns = []
}: NoiseFilterOptions): (value: string) => boolean {
  const literalSet = new Set(literals)

  return (value): boolean => {
    const lower = value.toLowerCase()
    return (
      !lower ||
      literalSet.has(lower) ||
      prefixes.some((prefix) => lower.startsWith(prefix)) ||
      patterns.some((pattern) => pattern.test(lower))
    )
  }
}

export function createRoleLabelDetector(
  definitions: readonly RoleLabelDefinition[]
): (value: string) => RoleLabel | null {
  return (value) => {
    const lower = value.toLowerCase()

    for (const definition of definitions) {
      if (lower === definition.label) {
        return { role: definition.role }
      }
      if (lower.startsWith(`${definition.label} `)) {
        return {
          role: definition.role,
          remainder: value.slice(definition.label.length).trim()
        }
      }
    }

    return null
  }
}

export function parseTaggedChatOutput(
  text: string,
  { detectRoleLabel, isNoiseLine = keepLine }: TaggedChatParserConfig = {}
): ParseResult {
  const messages: ParseResult['messages'] = []
  let currentRole: MessageRole | undefined
  let currentContent: string[] = []
  let currentTimestamp = ''
  const metadata: TaggedChatMetadata = { lastTimestamp: '' }

  const commitCurrent = (): void => {
    if (!currentRole || currentContent.length === 0) {
      return
    }

    const content = currentContent.join('\n').trim()
    if (!isNoiseLine(content)) {
      messages.push({ role: currentRole, content, timestamp: currentTimestamp })
    }
  }

  const acceptRoleContent = (role: MessageRole, content: string): void => {
    if (currentRole !== role) {
      commitCurrent()
      currentRole = role
      currentContent = []
      currentTimestamp = metadata.lastTimestamp
    }
    if (content && !isNoiseLine(content)) {
      currentContent.push(content)
    }
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const lineWithoutTag = trimmed.replace(/^\[.*?\]\s*/, '').trim()
    const roleLabel = detectRoleLabel?.(lineWithoutTag)

    if (roleLabel) {
      commitCurrent()
      currentRole = roleLabel.role
      currentContent = []
      currentTimestamp = metadata.lastTimestamp
      if (roleLabel.remainder && !isNoiseLine(roleLabel.remainder)) {
        currentContent.push(roleLabel.remainder)
      }
      continue
    }

    if (consumeMetadataLine(trimmed, metadata)) {
      continue
    }
    if (trimmed.startsWith('[USER]')) {
      acceptRoleContent('user', trimmed.replace('[USER]', '').trim())
    } else if (trimmed.startsWith('[ASSISTANT]')) {
      acceptRoleContent('assistant', trimmed.replace('[ASSISTANT]', '').trim())
    } else if (currentRole) {
      const content = trimmed.replace(/^\[.*?\]/, '').trim()
      if (content && !isNoiseLine(content)) {
        currentContent.push(content)
      }
    }
  }

  commitCurrent()
  return {
    messages,
    chatTitle: metadata.chatTitle,
    windowTitle: metadata.windowTitle,
    browserUrl: metadata.browserUrl
  }
}
