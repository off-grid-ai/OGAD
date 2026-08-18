/** makePlanner: builds the prompt, calls the injected completion with the plan
 *  schema, and parses the reply against the catalog's tool names. */
import { describe, expect, it, vi } from 'vitest'
import { makePlanner } from '../planner'
import { PLAN_SCHEMA, type ToolCatalogEntry } from '../planner-logic'

const catalog: ToolCatalogEntry[] = [
  { name: 'web_task', description: 'drive a site' },
  { name: 'open_url', description: 'open only' }
]

describe('makePlanner', () => {
  it('passes the plan schema + prompt to complete and parses the result', async () => {
    const complete = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('web_task')
      return JSON.stringify({
        steps: [{ tool: 'web_task', args: { url: 'https://youtube.com' }, why: 'interactive' }]
      })
    })
    const plan = await makePlanner(complete)('play X on YouTube', [], catalog)
    expect(complete).toHaveBeenCalledWith(expect.any(String), PLAN_SCHEMA)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.tool).toBe('web_task')
  })

  it('yields an empty plan when the model returns junk (falls back to reactive loop)', async () => {
    const plan = await makePlanner(async () => 'not json')('hi', [], catalog)
    expect(plan.steps).toEqual([])
  })
})
