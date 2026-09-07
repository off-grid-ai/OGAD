// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useEscapeToClose } from '../use-escape-to-close'

function Panel({ onClose }: { onClose: () => void }): React.ReactElement {
  useEscapeToClose(onClose)
  return <div>panel</div>
}

describe('useEscapeToClose', () => {
  afterEach(cleanup)

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn()
    render(<Panel onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores other keys', () => {
    const onClose = vi.fn()
    render(<Panel onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'a' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('lets an open nested picker handle the first Escape press', () => {
    const onClose = vi.fn()
    const { container } = render(
      <>
        <Panel onClose={onClose} />
        <div role="menu">
          <button type="button">Choice</button>
        </div>
      </>
    )

    fireEvent.keyDown(container.querySelector('[role="menu"]')!, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })

  it('unsubscribes on unmount (no close after the panel is gone)', () => {
    const onClose = vi.fn()
    const { unmount } = render(<Panel onClose={onClose} />)
    unmount()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })
})
