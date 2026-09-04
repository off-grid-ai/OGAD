import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useSyncExternalStore,
  type ClipboardEvent,
  type KeyboardEvent
} from 'react'
import { Button } from '@renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import type { ChatDraftStore } from './chat-draft-store'

interface SkillOption {
  name: string
  description: string
}

export interface ChatDraftInputHandle {
  focus: () => void
}

interface ChatDraftInputProps {
  store: ChatDraftStore
  skills: readonly SkillOption[]
  mode: 'ask' | 'image'
  activeProjectName?: string
  attachmentPending: boolean
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  onSubmit: () => void
}

function useDraft(store: ChatDraftStore): string {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

function matchingSkills(value: string, skills: readonly SkillOption[]): readonly SkillOption[] {
  if (!value.startsWith('/') || /\s/.test(value)) return []
  const query = value.slice(1).toLowerCase()
  return skills.filter((skill) => skill.name.toLowerCase().includes(query))
}

export const ChatDraftInput = forwardRef<ChatDraftInputHandle, ChatDraftInputProps>(
  function DraftInput(
    { store, skills, mode, activeProjectName, attachmentPending, onPaste, onSubmit },
    forwardedRef
  ): React.JSX.Element {
    const value = useDraft(store)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const matches = mode === 'ask' ? matchingSkills(value, skills) : []

    useImperativeHandle(forwardedRef, () => ({
      focus: () => textareaRef.current?.focus()
    }))

    useEffect(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 208)}px`
    }, [value])

    const completeSkill = (skill: SkillOption): void => {
      store.set(`/${skill.name} `)
      textareaRef.current?.focus()
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (matches.length > 0) {
        const query = value.slice(1).toLowerCase()
        const exact = skills.some((skill) => skill.name.toLowerCase() === query)
        if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !exact)) {
          event.preventDefault()
          completeSkill(matches[0]!)
          return
        }
      }
      if (event.key !== 'Enter' || event.shiftKey) return
      event.preventDefault()
      if (!attachmentPending) onSubmit()
    }

    return (
      <>
        {matches.length > 0 ? (
          <div className="absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-md border border-border bg-popover py-1 text-sm text-popover-foreground shadow-lg">
            <div className="flex items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wide text-neutral-600">
              <span>Skills</span>
              <span className="normal-case text-neutral-700">Tab to complete</span>
            </div>
            {matches.slice(0, 6).map((skill, index) => (
              <button
                key={skill.name}
                type="button"
                onClick={() => completeSkill(skill)}
                className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left transition-colors hover:bg-neutral-900 ${index === 0 ? 'bg-neutral-900/60' : ''}`}
              >
                <span className="text-green-500">/{skill.name}</span>
                {skill.description ? (
                  <span className="line-clamp-1 text-[11px] text-neutral-500">
                    {skill.description}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => store.set(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          rows={1}
          placeholder={
            mode === 'image'
              ? 'Describe an image to generate…'
              : activeProjectName
                ? `Ask about “${activeProjectName}”…`
                : 'Ask anything…'
          }
          className="max-h-52 w-full resize-none overflow-y-auto bg-transparent px-3.5 pt-3 text-sm text-foreground placeholder:text-muted-foreground outline-none"
        />
      </>
    )
  }
)

interface ChatDraftSendButtonProps {
  store: ChatDraftStore
  hasAttachments: boolean
  attachmentPending: boolean
  onSubmit: () => void
}

export function ChatDraftSendButton({
  store,
  hasAttachments,
  attachmentPending,
  onSubmit
}: ChatDraftSendButtonProps): React.JSX.Element {
  const value = useDraft(store)
  const disabled = (!value.trim() && !hasAttachments) || attachmentPending

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          onClick={onSubmit}
          disabled={disabled}
          title={attachmentPending ? 'Waiting for attachment to finish processing…' : 'Send'}
          className="size-8 rounded-full"
        >
          <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 10l7-7m0 0l7 7m-7-7v18"
            />
          </svg>
        </Button>
      </TooltipTrigger>
      <TooltipContent>{attachmentPending ? 'Waiting for attachment' : 'Send'}</TooltipContent>
    </Tooltip>
  )
}
