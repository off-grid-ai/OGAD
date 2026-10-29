// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  confirmDialog,
  noticeDialog,
  settleConfirmDialog,
  useConfirmDialogState
} from '../confirm-dialog'
import { clearDataCategoryDialog, deleteModelDialog } from '../confirm-dialog-copy'

function onScreen(): ReturnType<typeof useConfirmDialogState>['queue'][number] {
  const { result } = renderHook(() => useConfirmDialogState())
  const current = result.current.queue[0]
  if (!current) throw new Error('no dialog on screen')
  return current
}

describe('confirmDialog', () => {
  it('resolves with the answer and leaves nothing waiting', async () => {
    const yes = confirmDialog(deleteModelDialog('Qwen'))
    settleConfirmDialog(onScreen(), true)
    await expect(yes).resolves.toBe(true)

    const no = confirmDialog(deleteModelDialog('Qwen'))
    settleConfirmDialog(onScreen(), false)
    await expect(no).resolves.toBe(false)

    const { result } = renderHook(() => useConfirmDialogState())
    expect(result.current.queue).toHaveLength(0)
  })

  it('shows a second request only after the first is answered', async () => {
    const first = confirmDialog({ title: 'First?' })
    const second = confirmDialog({ title: 'Second?' })
    expect(onScreen().title).toBe('First?')

    const firstRequest = onScreen()
    settleConfirmDialog(firstRequest, true)
    expect(onScreen().title).toBe('Second?')

    // Answering an already-answered request does not touch the one now on screen.
    settleConfirmDialog(firstRequest, false)
    expect(onScreen().title).toBe('Second?')

    settleConfirmDialog(onScreen(), false)
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(false)
  })

  it('keeps the last request as shown after it settles, so the popup can animate out', () => {
    void confirmDialog({ title: 'Closing?' })
    const request = onScreen()
    settleConfirmDialog(request, false)
    const { result } = renderHook(() => useConfirmDialogState())
    expect(result.current.queue).toHaveLength(0)
    expect(result.current.shown?.title).toBe('Closing?')
  })

  it('answers no to a request identical to one already waiting, so a double click acts once', async () => {
    const first = confirmDialog(deleteModelDialog('Qwen'))
    const repeat = confirmDialog(deleteModelDialog('Qwen'))
    await expect(repeat).resolves.toBe(false)

    const { result } = renderHook(() => useConfirmDialogState())
    expect(result.current.queue).toHaveLength(1)

    // A different question still waits its turn.
    const other = confirmDialog(deleteModelDialog('Gemma'))
    expect(renderHook(() => useConfirmDialogState()).result.current.queue).toHaveLength(2)

    settleConfirmDialog(onScreen(), true)
    settleConfirmDialog(onScreen(), false)
    await expect(first).resolves.toBe(true)
    await expect(other).resolves.toBe(false)
  })
})

describe('noticeDialog', () => {
  it('offers one button and resolves when dismissed', async () => {
    const dismissed = noticeDialog({ title: 'Import failed', description: 'Bad file' })
    const request = onScreen()
    expect(request.cancelLabel).toBeNull()
    expect(request.confirmLabel).toBe('OK')
    settleConfirmDialog(request, true)
    await expect(dismissed).resolves.toBeUndefined()
  })

  it('shows a repeated notice once, and both callers wait until it is dismissed', async () => {
    const settledOrder: string[] = []
    const first = noticeDialog({ title: 'Import failed', description: 'Bad file' }).then(() =>
      settledOrder.push('first')
    )
    const repeat = noticeDialog({ title: 'Import failed', description: 'Bad file' }).then(() =>
      settledOrder.push('repeat')
    )

    expect(renderHook(() => useConfirmDialogState()).result.current.queue).toHaveLength(1)
    await new Promise((tick) => setTimeout(tick, 0))
    expect(settledOrder).toEqual([])

    settleConfirmDialog(onScreen(), true)
    await Promise.all([first, repeat])
    expect(settledOrder).toEqual(['first', 'repeat'])
  })
})

describe('clearDataCategoryDialog', () => {
  it('names the category and the age limit', () => {
    expect(clearDataCategoryDialog({ categoryLabel: 'Screen captures' }).title).toBe(
      'Delete all screen captures?'
    )
    expect(
      clearDataCategoryDialog({ categoryLabel: 'Screen captures', olderThanDays: 30 }).title
    ).toBe('Delete screen captures older than 30 days?')
  })
})
