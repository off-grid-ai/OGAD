import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { collectUiActionIds, uiActionIdsInSource } from '../../../../scripts/config/ui-action-ids'

describe('the ui_action allow-list', () => {
  it('holds fixed ids from source and never a computed label', () => {
    const ids = uiActionIdsInSource(`
      <button data-action="new-chat" />
      <button data-testid='send-button' aria-label="Send message" />
      <IconButton aria-label={open ? 'Collapse sidebar' : "Expand sidebar"} />
      <SidePanel ariaLabel="Active models" />
      <button aria-label={\`Delete \${doc.name}\`} />
      <button aria-label={doc.name} />
      <div data-testid={\`row-\${row.id}\`} />
      jsx("button", { "aria-label": "Close", children })
    `)
    expect(ids.sort()).toEqual(
      [
        'active-models',
        'close',
        'collapse-sidebar',
        'expand-sidebar',
        'new-chat',
        'send-button',
        'send-message'
      ].sort()
    )
  })

  it('collects the app source quickly enough to run at build time', () => {
    const started = Date.now()
    const ids = collectUiActionIds([resolve(__dirname, '../../../renderer/src')])
    expect(ids.length).toBeGreaterThan(100)
    expect(ids.every((id) => /^[a-z0-9][a-z0-9:_-]{0,63}$/.test(id))).toBe(true)
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})
