import { preprocessChatMarkdown } from '@offgrid/sync'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

/**
 * Desktop's native Markdown rendering rules.
 *
 * Shared owns the text grammar and preprocessing. Desktop owns HTML and visual styles. Explicit
 * font weights are required because the app reset intentionally gives every element normal weight.
 */
export const chatMarkdownComponents: Components = {
  h1: ({ children }) => (
    <h1
      className="mb-2 mt-3 text-base font-bold text-neutral-100 first:mt-0"
      style={{ fontWeight: 700 }}
    >
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2
      className="mb-1.5 mt-3 text-sm font-bold text-neutral-100 first:mt-0"
      style={{ fontWeight: 700 }}
    >
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3
      className="mb-1 mt-2.5 text-sm font-semibold text-neutral-200 first:mt-0"
      style={{ fontWeight: 600 }}
    >
      {children}
    </h3>
  ),
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0" style={{ listStyleType: 'disc' }}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0" style={{ listStyleType: 'decimal' }}>
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-neutral-700 pl-3 text-neutral-400">
      {children}
    </blockquote>
  ),
  strong: ({ children }) => (
    <strong className="font-bold text-neutral-100" style={{ fontWeight: 700 }}>
      {children}
    </strong>
  ),
  hr: () => <hr className="my-3 border-neutral-800" />,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-green-500 underline">
      {children}
    </a>
  ),
  code: ({ children, ...props }) => {
    const inline = !('className' in props)
    return (
      <code
        className={`font-mono text-[0.9em] bg-neutral-800/60 rounded ${inline ? 'px-1 py-0.5' : 'block px-2.5 py-2 overflow-x-auto'}`}
      >
        {children}
      </code>
    )
  },
  pre: ({ children }) => <pre className="my-2 overflow-x-auto last:mb-0">{children}</pre>
}

interface ChatMarkdownProps {
  content: string
  components?: Components
}

export function ChatMarkdown({
  content,
  components
}: Readonly<ChatMarkdownProps>): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkBreaks]}
      components={components ?? chatMarkdownComponents}
    >
      {preprocessChatMarkdown(content)}
    </ReactMarkdown>
  )
}
