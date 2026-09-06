/**
 * Message markdown: inline citation links that open their source, and skill mentions in a user
 * turn.
 */
import ReactMarkdown, { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { presetForSkillName } from './explore/presetCatalog'
import { type ChatMessage, type RagContext } from '@renderer/lib/chat-transcript-types'
import { Button } from '@renderer/components/ui/button'
import { markdownComponents, openUnifiedContext, renderedMessageContent, type ContextNavigation } from './chat-message-projection'

function makeCiteComponents(
  unified: RagContext['unified'],
  navigation: ContextNavigation
): Components {
  return {
    ...markdownComponents,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a: ({ href, children }: any) => {
      const match = typeof href === 'string' ? /^cite:(\d+)$/.exec(href) : null
      if (!match || !unified) {
        const DefaultAnchor = markdownComponents.a
        return DefaultAnchor ? (
          <DefaultAnchor href={href}>{children}</DefaultAnchor>
        ) : (
          <>{children}</>
        )
      }
      const source = unified[Number.parseInt(match[1]!, 10) - 1]
      return (
        <button
          type="button"
          onClick={() => {
            if (source) openUnifiedContext(source, navigation)
          }}
          title={
            source
              ? `${source.kind} · ${source.surface}${source.title ? ` · ${source.title}` : ''}`
              : 'source'
          }
          className="mx-0.5 inline-flex items-center rounded-sm border border-green-500/40 bg-green-500/10 px-1 align-baseline text-[0.72em] font-semibold text-green-500 transition-colors hover:bg-green-500/20"
        >
          {children}
        </button>
      )
    }
  }
}

const SKILL_MENTION_LINK_PREFIX = '#offgrid-skill-'

function renderUserSkillMention(content: string, installedSkillNames: readonly string[]): string {
  const match = /^\/([a-z0-9][a-z0-9_-]*)(?=\s|$)/i.exec(content)
  if (!match) return content
  const name = match[1]!
  const isInstalled = installedSkillNames.some(
    (installedName) => installedName.toLowerCase() === name.toLowerCase()
  )
  if (!isInstalled && !presetForSkillName(name)) return content
  return `[/${name}](${SKILL_MENTION_LINK_PREFIX}${encodeURIComponent(name)})${content.slice(match[0].length)}`
}

function makeUserMessageComponents(navigation: ContextNavigation): Components {
  return {
    ...markdownComponents,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a: ({ href, children }: any) => {
      const encodedName =
        typeof href === 'string' && href.startsWith(SKILL_MENTION_LINK_PREFIX)
          ? href.slice(SKILL_MENTION_LINK_PREFIX.length)
          : null
      if (!encodedName) {
        const DefaultAnchor = markdownComponents.a
        return DefaultAnchor ? (
          <DefaultAnchor href={href}>{children}</DefaultAnchor>
        ) : (
          <>{children}</>
        )
      }

      const name = /^[a-z0-9][a-z0-9_-]*$/i.test(encodedName) ? encodedName : null
      if (!name) return <>{children}</>
      const preset = presetForSkillName(name)
      const isInstalled = navigation.installedSkillNames?.some(
        (installedName) => installedName.toLowerCase() === name.toLowerCase()
      )
      if (!preset && !isInstalled) return <>{children}</>

      return (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="mx-0.5 inline-flex h-6 border-green-500/40 bg-green-500/10 px-1.5 align-baseline font-mono font-normal text-green-500 shadow-none hover:bg-green-500/20 hover:text-green-400"
          aria-label={`Open /${name} skill`}
          title={`Open /${name}`}
          onClick={() => {
            if (preset && navigation.onOpenSkillPreset) navigation.onOpenSkillPreset(preset)
            else navigation.onOpenInstalledSkill?.(name)
          }}
        >
          {children}
        </Button>
      )
    }
  }
}

export function MessageMarkdown({
  message,
  navigation
}: Readonly<{
  message: ChatMessage
  navigation: ContextNavigation
}>): React.JSX.Element {
  const components =
    message.role === 'assistant'
      ? makeCiteComponents(message.context?.unified, navigation)
      : makeUserMessageComponents(navigation)
  const content =
    message.role === 'user'
      ? renderUserSkillMention(
          renderedMessageContent(message),
          navigation.installedSkillNames ?? []
        )
      : renderedMessageContent(message)
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>
      {content}
    </ReactMarkdown>
  )
}

/**
 * What the generation cost, under the answer that cost it.
 *
 * Only the detailed fields the run actually produced: a server that reports no token counts shows
 * a time and nothing else, because "0 tok/s" would be a lie. The caller applies the generation
 * details preference. The basic response duration stays in the assistant action row either way.
 */
