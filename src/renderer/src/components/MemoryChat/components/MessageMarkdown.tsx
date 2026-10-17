import { memo } from 'react'
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { Button } from '@renderer/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger
} from '@renderer/components/ui/tooltip'
import { chatMarkdownComponents } from '../../chat-markdown-components'
import { presetForSkillName } from '../../explore/presetCatalog'
import type { ChatMessage, ContextNavigation, RagContext } from '../types'
import { renderedMessageContent, withoutArtifactFences } from '../utlis'
import { openUnifiedContext } from './MessageContext'

const markdownComponents = chatMarkdownComponents

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

const BARE_DOMAIN =
  /(?<![\w@/.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{2,5})?(?:\/[^\s<>]*)?)/gi
const TRAILING_LINK_PUNCTUATION = /[.,!?;:]+$/

function splitBareDomains(value: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = []
  let cursor = 0

  for (const match of value.matchAll(BARE_DOMAIN)) {
    const start = match.index
    const matchedValue = match[1]!
    let domain = matchedValue.replace(TRAILING_LINK_PUNCTUATION, '')
    while (domain.endsWith(')') && domain.split(')').length - 1 > domain.split('(').length - 1) {
      domain = domain.slice(0, -1)
    }
    if (!domain) continue
    if (start > cursor) nodes.push({ type: 'text', value: value.slice(cursor, start) })
    nodes.push({
      type: 'link',
      url: `https://${domain}`,
      children: [{ type: 'text', value: domain }]
    })
    cursor = start + domain.length
  }

  if (cursor === 0) return [{ type: 'text', value }]
  if (cursor < value.length) nodes.push({ type: 'text', value: value.slice(cursor) })
  return nodes
}

function linkBareDomains(node: MarkdownNode): void {
  if (!node.children || node.type === 'link' || node.type === 'linkReference') return
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && child.value) return splitBareDomains(child.value)
    linkBareDomains(child)
    return [child]
  })
}

function remarkBareDomains(): (tree: MarkdownNode) => void {
  return linkBareDomains
}

/** The default transform drops links with a protocol it does not know, which is every `cite:N`
 *  link an answer's [S#] tags become. Those are kept for the citation pills; the rest is unchanged. */
const keepCitations = (url: string): string =>
  /^cite:\d+$/.test(url) ? url : defaultUrlTransform(url)

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
      if (source?.kind === 'attachment') {
        // A document passage: the pill names the page; hovering shows the passage it cites.
        const page = source.title.split(' · ').at(-1) ?? source.title
        return (
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => openUnifiedContext(source, navigation)}
                  aria-label={`Open ${source.surface}, ${page}`}
                  className="mx-0.5 inline-flex items-center rounded-sm border border-green-500/40 bg-green-500/10 px-1 align-baseline text-[0.72em] font-semibold text-green-500 transition-colors hover:bg-green-500/20"
                >
                  {page}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-xs space-y-1 text-left">
                <span className="block text-xs font-medium">{source.surface}</span>
                <span className="line-clamp-5 block text-xs opacity-80">{source.snippet}</span>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )
      }
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
  return content.replace(
    /(^|\s)\/([a-z0-9][a-z0-9_-]*)(?=\s|$)/gi,
    (mention, space: string, name: string) => {
      const isInstalled = installedSkillNames.some(
        (installedName) => installedName.toLowerCase() === name.toLowerCase()
      )
      if (!isInstalled && !presetForSkillName(name)) return mention
      return `${space}[/${name}](${SKILL_MENTION_LINK_PREFIX}${encodeURIComponent(name)})`
    }
  )
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

function MessageMarkdownComponent({
  message,
  navigation,
  withoutArtifact = false
}: Readonly<{
  message: ChatMessage
  navigation: ContextNavigation
  /** The artifact card shows the code; the markdown keeps the sentences around it. */
  withoutArtifact?: boolean
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
      : withoutArtifact
        ? withoutArtifactFences(renderedMessageContent(message))
        : renderedMessageContent(message)
  return (
    <ReactMarkdown
      remarkPlugins={
        message.role === 'user'
          ? [remarkGfm, remarkBreaks, remarkBareDomains]
          : [remarkGfm, remarkBreaks]
      }
      components={components}
      urlTransform={keepCitations}
    >
      {content}
    </ReactMarkdown>
  )
}

/**
 * What the generation cost, under the answer that cost it.
 *
 * Only the fields the run actually produced: a server that reports no token counts shows a time and
 * nothing else, because "0 tok/s" would be a lie.
 */
export const MessageMarkdown = memo(MessageMarkdownComponent)
