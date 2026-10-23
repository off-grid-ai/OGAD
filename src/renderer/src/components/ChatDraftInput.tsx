import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type KeyboardEvent
} from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { Kbd, KbdGroup } from '@offgrid/operator-ui/operator/coss/kbd'
import {
  PromptInputCommand,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputCommandList,
  PromptInputSubmit
} from '@offgrid/operator-ui/operator/elements/prompt-input'
import { TextareaInlineCompletion } from '@offgrid/operator-ui/operator/media/textarea-inline-completion'
import { Highlight } from '@offgrid/operator-ui/operator/presence'
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
  mode: 'ask' | 'image' | 'video'
  activeProjectName?: string
  attachmentPending: boolean
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  onSubmit: () => void
  onSendNow?: () => void
  busy?: boolean
  suggestion?: string
}

function useDraft(store: ChatDraftStore): string {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

function skillQuery(value: string): string | null {
  const match = /(?:^|\s)\/([a-z0-9_-]*)$/i.exec(value)
  return match ? match[1]!.toLowerCase() : null
}

function matchingSkills(value: string, skills: readonly SkillOption[]): readonly SkillOption[] {
  const query = skillQuery(value)
  if (query === null) return []
  return skills.filter((skill) => skill.name.toLowerCase().includes(query))
}

export const ChatDraftInput = forwardRef<ChatDraftInputHandle, ChatDraftInputProps>(
  function DraftInput(
    {
      store,
      skills,
      mode,
      activeProjectName,
      attachmentPending,
      onPaste,
      onSubmit,
      onSendNow,
      busy,
      suggestion
    },
    forwardedRef
  ): React.JSX.Element {
    const value = useDraft(store)
    const textareaRef = useRef<HTMLTextAreaElement>(null)
    const matches = mode === 'ask' ? matchingSkills(value, skills) : []
    const query = skillQuery(value) ?? ''
    // Escape sets a suggestion aside; a new suggestion offers itself again.
    const [dismissedSuggestion, setDismissedSuggestion] = useState<string>()
    const offeredSuggestion =
      mode === 'ask' && !busy && !attachmentPending && !value && suggestion !== dismissedSuggestion
        ? suggestion
        : undefined

    useImperativeHandle(forwardedRef, () => ({
      focus: () => textareaRef.current?.focus()
    }))

    // Fit the box to its text. A hidden box (a split pane while one input serves every pane) has
    // no layout and would measure 0, so it is measured again once it is shown or resized.
    useEffect(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      const fit = (): void => {
        if (textarea.clientWidth === 0) return
        textarea.style.height = 'auto'
        textarea.style.height = `${Math.min(textarea.scrollHeight, 208)}px`
      }
      fit()
      let width = textarea.clientWidth
      const observer = new ResizeObserver(() => {
        if (textarea.clientWidth === width) return
        width = textarea.clientWidth
        fit()
      })
      observer.observe(textarea)
      return () => observer.disconnect()
    }, [value])

    const completeSkill = (skill: SkillOption): void => {
      store.set(`${value.slice(0, value.lastIndexOf('/'))}/${skill.name} `)
      textareaRef.current?.focus()
    }

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return
      // ⌘⇧V pastes plain text into the box, however long, instead of attaching it as
      // "Pasted text". insertText keeps it on the undo stack like typing.
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        void window.api
          .readClipboardText()
          .then((text) => {
            if (text) document.execCommand('insertText', false, text)
          })
          .catch(() => undefined)
        return
      }
      // Tab on an offered suggestion and Escape are TextareaInlineCompletion's (onAccept/onDismiss).
      if (matches.length > 0 && !event.metaKey && !event.ctrlKey) {
        const query = value.slice(value.lastIndexOf('/') + 1).toLowerCase()
        const exact = skills.some((skill) => skill.name.toLowerCase() === query)
        if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !exact)) {
          event.preventDefault()
          completeSkill(matches[0]!)
          return
        }
      }
      if (event.key !== 'Enter' || event.shiftKey) return
      event.preventDefault()
      if (!attachmentPending) {
        if ((event.metaKey || event.ctrlKey) && onSendNow) onSendNow()
        else onSubmit()
      }
    }

    return (
      <>
        <AnimatePresence>
          {matches.length > 0 ? (
            <motion.div
              key="skills"
              initial={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: 6, filter: 'blur(4px)' }}
              transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
              className="absolute bottom-full left-0 z-20 mb-2 w-72"
            >
              {/* The textarea stays the input: the list follows what is typed after "/", and the
                  first match is the one Tab or Enter completes. */}
              <PromptInputCommand
                label="Skills"
                shouldFilter={false}
                value={matches[0]!.name}
                className="rounded-md border border-border py-1 text-sm shadow-lg"
              >
                <div className="flex items-center justify-between px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <span>Skills</span>
                  <span className="normal-case text-muted-foreground/80">
                    <Kbd className="h-4 text-[10px]">Tab</Kbd> to complete
                  </span>
                </div>
                <PromptInputCommandList>
                  <PromptInputCommandGroup className="p-0">
                    {matches.slice(0, 6).map((skill) => (
                      <PromptInputCommandItem
                        key={skill.name}
                        value={skill.name}
                        onSelect={() => completeSkill(skill)}
                        className="flex-col items-start gap-0.5 rounded-none px-3 py-1.5"
                      >
                        <span className="text-primary">
                          /<Highlight text={skill.name} query={query} />
                        </span>
                        {skill.description ? (
                          <span className="line-clamp-1 text-[11px] text-muted-foreground">
                            {skill.description}
                          </span>
                        ) : null}
                      </PromptInputCommandItem>
                    ))}
                  </PromptInputCommandGroup>
                </PromptInputCommandList>
              </PromptInputCommand>
            </motion.div>
          ) : null}
        </AnimatePresence>
        {/* The suggestion waits as ghost text at the caret; the placeholder names the same words
            (and the Tab key) while the field is not focused. data-slot makes it the composer
            group's control, so header and footer clicks focus it. */}
        <TextareaInlineCompletion
          ref={textareaRef}
          data-slot="input-group-control"
          containerClassName="w-full"
          suggestion={offeredSuggestion}
          onAccept={(nextValue) => store.set(nextValue)}
          onDismiss={() => setDismissedSuggestion(offeredSuggestion)}
          value={value}
          onChange={(event) => store.set(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={onPaste}
          rows={1}
          aria-label="Message"
          aria-description={
            busy
              ? 'Enter to queue. Command or Control plus Enter to send now. Shift plus Enter for a new line.'
              : offeredSuggestion
                ? 'Tab to use the suggested message. Enter to send. Shift plus Enter for a new line.'
                : 'Enter to send. Shift plus Enter for a new line.'
          }
          placeholder={
            offeredSuggestion
              ? `${offeredSuggestion} (Tab)`
              : mode === 'image'
                ? 'Describe an image to generate…'
                : mode === 'video'
                  ? 'Describe a video to generate…'
                  : activeProjectName
                    ? `Ask about “${activeProjectName}”…`
                    : 'Ask anything…'
          }
          className="min-h-0 max-h-52 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent px-3.5 pt-3 pb-1 text-sm text-foreground placeholder:text-muted-foreground outline-none focus-visible:outline-none"
        />
        {busy ? (
          <p className="px-3.5 pt-1 text-[10px] text-muted-foreground">
            <Kbd className="h-4 text-[10px]">Enter</Kbd> to queue ·{' '}
            <KbdGroup>
              <Kbd className="h-4 text-[10px]">⌘/Ctrl</Kbd>+<Kbd className="h-4 text-[10px]">Enter</Kbd>
            </KbdGroup>{' '}
            to send now
          </p>
        ) : null}
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
  const title = attachmentPending ? 'Waiting for attachment to finish processing…' : 'Send'

  // Sending stays with the composer's own handler (Enter, ⌘Enter and this button), so the submit
  // is a plain button rather than a form submit.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PromptInputSubmit
          type="button"
          onClick={onSubmit}
          disabled={disabled}
          title={title}
          aria-label={title}
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
        </PromptInputSubmit>
      </TooltipTrigger>
      <TooltipContent>{attachmentPending ? 'Waiting for attachment' : 'Send'}</TooltipContent>
    </Tooltip>
  )
}
