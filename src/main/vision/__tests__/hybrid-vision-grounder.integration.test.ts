/**
 * Real hybrid Computer Use composition through screenshot preparation and Shared policy response
 * serialization. Only the remote reasoner boundary is controlled.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { TASK_GUIDANCE_APPLIED_TRACE } from '../../tasks/task-guide'
import {
  createHybridVisionGrounder,
  type HybridVisionGrounderDependencies
} from '../hybrid-vision-grounder'
import type { VisionGroundingInput } from '../vision-agent'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-hybrid-grounder-'))
const screenshot = path.join(root, 'screen.png')

beforeAll(async () => {
  await sharp({
    create: { width: 32, height: 24, channels: 4, background: '#ffffff' }
  })
    .png()
    .toFile(screenshot)
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function input(): VisionGroundingInput {
  return {
    goal: 'Save the report',
    image: screenshot,
    history: ['Opened the editor'],
    retrievedFacts: ['The report belongs in Documents'],
    policyHistory: [],
    guidance: ['private destination'],
    currentMilestone: 'Confirm the saved report is visible',
    verifiedActions: ['Clicked Save'],
    coordinateFrame: {
      encoded: { width: 32, height: 24 },
      source: { width: 32, height: 24 }
    }
  }
}

describe('Desktop hybrid vision grounder', () => {
  it('turns a real prepared screenshot and one reasoner tool call into a terminal decision', async () => {
    const runReasoner = vi.fn<HybridVisionGrounderDependencies['runReasoner']>(async () => ({
      content: '',
      toolCalls: [
        {
          id: 'reasoner-call-1',
          name: 'complete_milestone',
          arguments: JSON.stringify({
            summary: 'The report is saved.',
            visible_evidence: 'The editor shows Saved.'
          })
        }
      ]
    }))
    const ground = createHybridVisionGrounder('desktop', {
      runReasoner,
      reasonerRouteId: 'remote:reasoner',
      withSpecialist: async () => {
        throw new Error('The specialist must not run for a completed milestone.')
      },
      activeSpecialistAdapter: async () => {
        throw new Error('The specialist must not load for a completed milestone.')
      }
    })

    const result = await ground(input())

    expect(result.decision).toEqual({
      kind: 'phase_complete',
      actionText: 'Milestone complete',
      summary: 'The report is saved.',
      decisionRationale: 'The editor shows Saved.'
    })
    expect(result.screenshotDataUrl).toMatch(/^data:image\/png;base64,/)
    expect(result.modelInput).toContain('Task brief:\\nSave the report')
    expect(result.modelInput).not.toContain('private destination')
    expect(result.modelInput).toContain(TASK_GUIDANCE_APPLIED_TRACE)
    expect(runReasoner).toHaveBeenCalledOnce()
    expect(JSON.stringify(runReasoner.mock.calls[0]?.[0])).toContain('private destination')
    expect(runReasoner.mock.calls[0]?.[0]).toMatchObject({
      generationRouteId: 'remote:reasoner',
      toolChoice: 'required',
      separateReasoning: true
    })
  })

  it('fails closed when the reasoner does not return exactly one transition tool', async () => {
    const ground = createHybridVisionGrounder('embedded_browser', {
      runReasoner: async () => ({ content: 'Done', toolCalls: [] }),
      withSpecialist: async () => {
        throw new Error('The specialist must not run after an invalid reasoner response.')
      },
      activeSpecialistAdapter: async () => {
        throw new Error('The specialist must not load after an invalid reasoner response.')
      }
    })

    await expect(ground(input())).resolves.toMatchObject({
      decision: {
        kind: 'invalid',
        actionText: '',
        error: 'the reasoner returned 0 tool calls'
      }
    })
  })
})
