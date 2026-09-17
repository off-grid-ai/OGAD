import { memo } from 'react'
import { Check, DotsThree, PencilSimple, Waveform } from '@phosphor-icons/react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@renderer/components/ui/dropdown-menu'

export function CopyAction({
  copied,
  onCopy
}: Readonly<{ copied: boolean; onCopy: () => void }>): React.JSX.Element {
  console.log('MemoryChat CopyAction rendered')
  const color = copied ? 'text-green-500' : 'text-neutral-600 hover:text-green-500'
  return (
    <DropdownMenuItem
      onSelect={onCopy}
      className={`flex items-center gap-1 text-[11px] transition-colors ${color}`}
      title="Copy"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" weight="bold" />
      ) : (
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 16h8M8 12h8m-7 8h6a2 2 0 002-2V6a2 2 0 00-2-2h-3.586a1 1 0 00-.707.293l-2.414 2.414A1 1 0 009 7.414V18a2 2 0 002 2z"
          />
        </svg>
      )}
      {copied ? 'Copied' : 'Copy'}
    </DropdownMenuItem>
  )
}

export function RegenerateAction({
  label,
  title,
  disabled,
  onRegenerate
}: Readonly<{
  label: string
  title: string
  disabled?: boolean
  onRegenerate: () => void
}>): React.JSX.Element {
  console.log('MemoryChat RegenerateAction rendered')
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={onRegenerate}
      className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors enabled:hover:text-green-500 disabled:cursor-not-allowed disabled:opacity-40"
      title={title}
    >
      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        />
      </svg>
      {label}
    </DropdownMenuItem>
  )
}

function UserMessageActionsComponent({
  copied,
  regenerationDisabled,
  onCopy,
  onEdit,
  onRegenerate
}: Readonly<{
  copied: boolean
  regenerationDisabled: boolean
  onCopy: () => void
  onEdit: () => void
  onRegenerate: () => void
}>): React.JSX.Element {
  console.log('MemoryChat UserMessageActions rendered')
  return (
    <MessageActionsMenu>
      <CopyAction copied={copied} onCopy={onCopy} />
      <RegenerateAction
        label="Resend"
        title={
          regenerationDisabled
            ? 'Wait for the current reply to finish'
            : 'Regenerate the reply to this message'
        }
        disabled={regenerationDisabled}
        onRegenerate={onRegenerate}
      />
      <DropdownMenuItem
        onSelect={onEdit}
        className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500"
        title="Edit this message"
      >
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
          />
        </svg>
        Edit
      </DropdownMenuItem>
    </MessageActionsMenu>
  )
}

function VoiceMessageActionsComponent({
  copied,
  regenerationDisabled,
  transcribing,
  canTranscribe,
  onCopy,
  onRegenerate,
  onEdit,
  onTranscribe
}: Readonly<{
  copied: boolean
  regenerationDisabled: boolean
  transcribing: boolean
  canTranscribe: boolean
  onCopy: () => void
  onRegenerate: () => void
  onEdit: () => void
  onTranscribe: () => void
}>): React.JSX.Element {
  console.log('MemoryChat VoiceMessageActions rendered')
  return (
    <MessageActionsMenu label="Voice message actions">
      <CopyAction copied={copied} onCopy={onCopy} />
      <RegenerateAction
        label="Resend"
        title={
          regenerationDisabled
            ? 'Wait for the current reply to finish'
            : 'Regenerate the reply to this message'
        }
        disabled={regenerationDisabled}
        onRegenerate={onRegenerate}
      />
      <DropdownMenuItem
        onSelect={onEdit}
        className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors hover:text-green-500"
        title="Edit this message"
      >
        <PencilSimple className="h-3.5 w-3.5" aria-hidden="true" />
        Edit
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={!canTranscribe || transcribing}
        onSelect={onTranscribe}
        className="flex items-center gap-1 text-[11px] text-neutral-600 transition-colors enabled:hover:text-green-500 disabled:cursor-not-allowed disabled:opacity-40"
        title={canTranscribe ? 'Transcribe this voice note again' : 'Voice note is not available'}
      >
        <Waveform className="h-3.5 w-3.5" aria-hidden="true" />
        Transcribe again
      </DropdownMenuItem>
    </MessageActionsMenu>
  )
}

export function MessageActionsMenu({
  children,
  label = 'Message actions'
}: Readonly<{ children: React.ReactNode; label?: string }>): React.JSX.Element {
  console.log('MemoryChat MessageActionsMenu rendered')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="rounded-sm px-1 text-neutral-500 transition-colors hover:text-neutral-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-green-500"
        >
          <DotsThree className="h-5 w-5" weight="bold" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

export const UserMessageActions = memo(UserMessageActionsComponent)
export const VoiceMessageActions = memo(VoiceMessageActionsComponent)
