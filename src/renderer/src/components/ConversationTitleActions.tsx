import { useState, type JSX, type KeyboardEvent } from 'react'
import { Check, DotsThree, PencilSimple, Trash, X } from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  Editable,
  EditableArea,
  EditableCancel,
  EditableInput,
  EditableLabel,
  EditableSubmit,
  EditableToolbar
} from '@offgrid/operator-ui/operator/dice/editable'
import { Button } from '@offgrid/operator-ui/operator/coss/button'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from '@offgrid/operator-ui/operator/coss/menu'
import type { RagConversationContract } from '../../../shared/ipc-contracts'

interface ConversationTitleActionsProps {
  conversation: RagConversationContract
  onRenamed: (conversation: RagConversationContract) => void
  onDelete: () => void | Promise<void>
}

export function ConversationTitleActions({
  conversation,
  onRenamed,
  onDelete
}: ConversationTitleActionsProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const displayTitle = conversation.title || 'Untitled'
  const reduceMotion = useReducedMotion()

  const beginRename = (): void => {
    setDraft(conversation.title || '')
    setError(null)
    setEditing(true)
  }

  const cancelRename = (): void => {
    setDraft('')
    setError(null)
    setEditing(false)
  }

  const saveRename = async (): Promise<void> => {
    const title = draft.trim()
    if (!title) {
      setError('Enter a conversation name.')
      return
    }

    setSaving(true)
    setError(null)
    try {
      const stored = await window.api.updateRagConversationTitle(conversation.id, title)
      onRenamed(stored)
      setEditing(false)
    } catch {
      setError('Rename failed. Try again.')
    } finally {
      setSaving(false)
    }
  }

  // The title edits where it sits (the preview's Details chapter). Saving is async and can fail,
  // so the editor stays open until the save lands (closeOnSubmit off), and leaving the field keeps
  // the draft open, as before, rather than saving it (submitOnBlur off).
  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      // Handled here, not by the panel behind: Escape leaves the rename, nothing else.
      event.preventDefault()
      cancelRename()
    }
  }

  if (editing) {
    return (
      <motion.div
        className="min-w-0"
        onClick={(event) => event.stopPropagation()}
        initial={reduceMotion ? false : { opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.16, 1, 0.3, 1] }}
      >
        <Editable
          value={draft}
          onValueChange={setDraft}
          editing
          onEditingChange={(next) => {
            if (!next) cancelRename()
          }}
          closeOnSubmit={false}
          submitOnBlur={false}
          onSubmit={() => void saveRename()}
          disabled={saving}
          invalid={error !== null}
          className="gap-0"
        >
          <EditableLabel className="sr-only">Rename conversation</EditableLabel>
          <div className="flex min-w-0 items-center gap-1">
            <EditableArea className="min-w-0 flex-1">
              <EditableInput
                aria-label="Rename conversation"
                onKeyDown={handleInputKeyDown}
                className="h-7 min-w-0 px-2 text-xs md:text-xs"
              />
            </EditableArea>
            <EditableToolbar className="flex items-center gap-1">
              <EditableSubmit
                aria-label="Save conversation name"
                disabled={saving}
                render={<Button variant="ghost" size="icon-xs" />}
              >
                <Check />
              </EditableSubmit>
              <EditableCancel
                aria-label="Cancel rename"
                disabled={saving}
                render={<Button variant="ghost" size="icon-xs" />}
              >
                <X />
              </EditableCancel>
            </EditableToolbar>
          </div>
        </Editable>
        <AnimatePresence initial={false}>
          {error && (
            <motion.p
              key="rename-error"
              role="alert"
              className="mt-1 text-[10px] text-destructive"
              initial={reduceMotion ? false : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
              transition={{ duration: reduceMotion ? 0 : 0.3, ease: [0.16, 1, 0.3, 1] }}
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>
      </motion.div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <p className="min-w-0 flex-1 truncate text-xs text-neutral-300">{displayTitle}</p>
      <Menu>
        <MenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Conversation actions for ${displayTitle}`}
              onClick={(event) => event.stopPropagation()}
              className="opacity-0 transition-all group-hover:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
            />
          }
        >
          <DotsThree />
        </MenuTrigger>
        <MenuPopup align="end" className="w-36">
          <MenuItem onClick={beginRename}>
            <PencilSimple />
            Rename
          </MenuItem>
          <MenuItem variant="destructive" onClick={() => void onDelete()}>
            <Trash />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  )
}
