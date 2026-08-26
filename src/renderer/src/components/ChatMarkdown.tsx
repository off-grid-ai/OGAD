import { preprocessChatMarkdown } from '@offgrid/sync'
import { safeChatExternalUrl } from '@offgrid/sync'
import { openChatLink } from '@renderer/lib/chat-link'
import { openTaskSidePanel } from '@renderer/lib/task-side-panel'
import { useTaskSessions } from '@renderer/lib/task-session-store'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { chatMarkdownComponents } from './chat-markdown-components'

const TASK_REFERENCE_TEXT = /(\b(?:the\s+)?task reference(?:\s+is)?:\s*)([A-Za-z0-9_-]+)/gi
const TASK_REFERENCE_PREFIX = '#offgrid-task:'

function ExternalChatLink({
  href,
  children
}: {
  href?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <a
      href={safeChatExternalUrl(href) ?? undefined}
      className="text-green-500 underline"
      onClick={(event) => {
        event.preventDefault()
        openChatLink(href)
      }}
    >
      {children}
    </a>
  )
}

function linkTaskReferences(content: string): string {
  return content.replace(
    TASK_REFERENCE_TEXT,
    (_match, prefix: string, taskId: string) =>
      `${prefix}[${taskId}](${TASK_REFERENCE_PREFIX}${taskId})`
  )
}

interface ChatMarkdownProps {
  content: string
  components?: Components
}

export function ChatMarkdown({
  content,
  components
}: Readonly<ChatMarkdownProps>): React.JSX.Element {
  const { tasks } = useTaskSessions()
  const taskAwareComponents: Components = {
    ...chatMarkdownComponents,
    a: ({ href, children }) => {
      if (!href?.startsWith(TASK_REFERENCE_PREFIX)) {
        return <ExternalChatLink href={href}>{children}</ExternalChatLink>
      }
      const taskId = href.slice(TASK_REFERENCE_PREFIX.length)
      const task = tasks.find((candidate) => candidate.taskId === taskId)
      if (!task) return <span className="font-mono text-muted-foreground">{children}</span>
      return (
        <button
          type="button"
          className="font-mono text-green-500 underline underline-offset-2 hover:text-green-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-500"
          onClick={() => openTaskSidePanel({ taskId, kind: task.kind, detail: true })}
          aria-label={`Open task details for ${taskId}`}
        >
          {children}
        </button>
      )
    }
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      components={components ?? taskAwareComponents}
    >
      {linkTaskReferences(preprocessChatMarkdown(content))}
    </ReactMarkdown>
  )
}
