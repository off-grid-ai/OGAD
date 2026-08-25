// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatToolRows } from '../ChatToolRows'

afterEach(cleanup)

describe('<ChatToolRows/>', () => {
  it('uses product names for legacy and canonical Web Use calls', () => {
    render(
      <ChatToolRows
        tools={[
          { name: 'web_task', status: 'running' },
          { name: 'web_use', status: 'completed', result: 'Done.' }
        ]}
      />
    )
    expect(screen.getByText('Using Web Use...')).toBeTruthy()
    expect(screen.getByText('Web Use')).toBeTruthy()
    expect(screen.queryByText(/web_task/)).toBeNull()
    expect(screen.queryByText(/web_use/)).toBeNull()
  })
})
