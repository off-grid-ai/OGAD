import React from 'react'
import { safeChatExternalUrl } from '@offgrid/application'
import { openChatLink } from '@renderer/lib/chat-link'
import type { Components } from 'react-markdown'

const element = React.createElement

export const chatMarkdownComponents: Components = {
  h1: ({ children }) =>
    element(
      'h1',
      {
        className: 'mb-2 mt-3 text-base font-bold text-neutral-100 first:mt-0',
        style: { fontWeight: 700 }
      },
      children
    ),
  h2: ({ children }) =>
    element(
      'h2',
      {
        className: 'mb-1.5 mt-3 text-sm font-bold text-neutral-100 first:mt-0',
        style: { fontWeight: 700 }
      },
      children
    ),
  h3: ({ children }) =>
    element(
      'h3',
      {
        className: 'mb-1 mt-2.5 text-sm font-semibold text-neutral-200 first:mt-0',
        style: { fontWeight: 600 }
      },
      children
    ),
  p: ({ children }) => element('p', { className: 'mb-2 last:mb-0' }, children),
  ul: ({ children }) =>
    element(
      'ul',
      { className: 'mb-2 list-disc space-y-1 pl-5 last:mb-0', style: { listStyleType: 'disc' } },
      children
    ),
  ol: ({ children }) =>
    element(
      'ol',
      {
        className: 'mb-2 list-decimal space-y-1 pl-5 last:mb-0',
        style: { listStyleType: 'decimal' }
      },
      children
    ),
  li: ({ children }) => element('li', { className: 'pl-0.5' }, children),
  blockquote: ({ children }) =>
    element(
      'blockquote',
      { className: 'my-2 border-l-2 border-neutral-700 pl-3 text-neutral-400' },
      children
    ),
  strong: ({ children }) =>
    element(
      'strong',
      { className: 'font-bold text-neutral-100', style: { fontWeight: 700 } },
      children
    ),
  hr: () => element('hr', { className: 'my-3 border-neutral-800' }),
  a: ({ href, children }) =>
    element(
      'a',
      {
        href: safeChatExternalUrl(href) ?? undefined,
        className: 'text-green-500 underline',
        onClick: (event: React.MouseEvent) => {
          event.preventDefault()
          openChatLink(href)
        }
      },
      children
    ),
  code: ({ children, ...props }) =>
    element(
      'code',
      {
        className: `font-mono text-[0.9em] bg-neutral-800/60 rounded ${'className' in props ? 'block px-2.5 py-2 overflow-x-auto' : 'px-1 py-0.5'}`
      },
      children
    ),
  pre: ({ children }) => element('pre', { className: 'my-2 overflow-x-auto last:mb-0' }, children)
}
