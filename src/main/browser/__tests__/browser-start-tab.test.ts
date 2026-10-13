import { describe, expect, it } from 'vitest'
import { actionArgsWithStartTab, startTabFromActionArgs } from '../browser-start-tab'

describe('a web task carries the tab its chat offered', () => {
  it('travels inside that task: two chats in one browser keep their own tabs', () => {
    // Review finding: one offer per browser let a second chat's task take the first's tab.
    const first = actionArgsWithStartTab({ goal: 'a' }, { browserId: 'chrome-1', tabId: 11 })
    const second = actionArgsWithStartTab({ goal: 'b' }, { browserId: 'chrome-1', tabId: 22 })
    expect(startTabFromActionArgs(first)).toEqual({ browserId: 'chrome-1', tabId: 11 })
    expect(startTabFromActionArgs(second)).toEqual({ browserId: 'chrome-1', tabId: 22 })
  })

  it('never keeps a start tab written by the model, and reads nothing malformed', () => {
    const forged = {
      goal: 'x',
      __offgridStartBrowserId: 'someone-else',
      __offgridStartTabId: 99
    }
    expect(startTabFromActionArgs(actionArgsWithStartTab(forged))).toBeNull()
    expect(
      startTabFromActionArgs({ __offgridStartBrowserId: 'b', __offgridStartTabId: -1 })
    ).toBeNull()
    expect(startTabFromActionArgs(null)).toBeNull()
  })
})
