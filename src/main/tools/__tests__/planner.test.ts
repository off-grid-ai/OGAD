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
    expect(complete).toHaveBeenCalledWith(expect.any(String), PLAN_SCHEMA, undefined, undefined)
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.tool).toBe('web_task')
  })

  it('retries planner narration once with validation feedback and accepts the model repair', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce('I will open the website now.')
      .mockResolvedValueOnce(
        JSON.stringify({
          steps: [
            {
              tool: 'web_task',
              args: { goal: 'open it', url: 'https://example.com' },
              why: 'The website needs interaction.'
            }
          ]
        })
      )

    const plan = await makePlanner(complete)('open it', [], catalog)

    expect(plan.steps.map(({ tool }) => tool)).toEqual(['web_task'])
    expect(complete).toHaveBeenCalledTimes(2)
    expect(complete.mock.calls[1]?.[0]).toMatch(/Validation feedback:/)
    expect(complete.mock.calls[1]?.[0]).toMatch(/not JSON/)
    expect(complete.mock.calls[1]?.[1]).toBe(PLAN_SCHEMA)
  })

  it('rejects after two invalid structured responses', async () => {
    const complete = vi.fn(async () => 'I will open the website now.')
    await expect(makePlanner(complete)('open it', [], catalog)).rejects.toThrow(
      /invalid structured plan after retry/i
    )
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('accepts a valid empty plan without a retry', async () => {
    const complete = vi.fn(async () => JSON.stringify({ steps: [] }))
    await expect(makePlanner(complete)('chat with me', [], catalog)).resolves.toEqual({ steps: [] })
    expect(complete).toHaveBeenCalledTimes(1)
  })
})
