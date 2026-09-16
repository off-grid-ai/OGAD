// @vitest-environment jsdom
/**
 * A user guides a running Computer Use task through the production composer.
 * The real task owner accepts it and the real hybrid grounder uses it for the
 * next decision. Electron, the screenshot, and the remote model are boundaries.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import sharp from 'sharp'

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'offgrid-guidance-ui-'))
const screenshot = path.join(profile, 'screen.png')

vi.mock('electron', () => ({
  app: {
    getPath: () => profile,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => undefined }
}))

import { TaskGuideComposer } from '../pro/renderer/components/browser/tasks/TaskGuideComposer'
import { createHybridVisionGrounder } from '../src/main/vision/hybrid-vision-grounder'
import { getTaskRun, recordTaskRun, resetTaskHistoryForTests } from '../src/main/tasks/task-history'
import {
  guideTask,
  registerTaskGuideHandler,
  resetTaskGuideHandlersForTests,
  taskGuideAvailability,
  TASK_GUIDANCE_TRACE
} from '../src/main/tasks/task-guide'
import type { VisionPolicyRequest } from '../src/main/vision/model-adapters/types'

const taskId = 'computer-use-guidance-ui'
const privateGuidance = 'Ask for dates before searching, private-839201'

function requestText(request: VisionPolicyRequest): string {
  return JSON.stringify(request.messages)
}

beforeAll(async () => {
  await sharp({
    create: { width: 32, height: 24, channels: 4, background: '#ffffff' }
  })
    .png()
    .toFile(screenshot)
})

afterEach(() => {
  cleanup()
  resetTaskGuideHandlersForTests()
  resetTaskHistoryForTests()
  Reflect.deleteProperty(window, 'api')
})

afterAll(() => {
  fs.rmSync(profile, { recursive: true, force: true })
})

describe('Computer Use live guidance', () => {
  it('uses guidance entered in the running-task UI for the next model decision', async () => {
    recordTaskRun({
      taskId,
      kind: 'computer_use',
      title: 'Find a flight',
      status: 'running'
    })
    const queuedGuidance: string[] = []
    registerTaskGuideHandler(taskId, (text) => {
      queuedGuidance.push(text)
      return true
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        tasks: {
          guideAvailability: async (id: string) => taskGuideAvailability(id),
          guideTask
        }
      }
    })

    render(<TaskGuideComposer taskId={taskId} />)
    const user = userEvent.setup()
    const editor = await screen.findByRole('textbox', { name: 'Task guidance' })
    await waitFor(() => expect((editor as HTMLTextAreaElement).disabled).toBe(false))
    await user.type(editor, privateGuidance)
    await user.click(screen.getByRole('button', { name: 'Send task guidance' }))
    expect(
      await screen.findByText('Guidance accepted. Applying it to the next decision.')
    ).toBeTruthy()

    const ground = createHybridVisionGrounder('desktop', {
      runReasoner: async (request) => {
        const followsGuidance = requestText(request).includes(privateGuidance)
        return {
          content: '',
          toolCalls: [
            {
              id: 'next-decision',
              name: 'call_user',
              arguments: JSON.stringify({
                reason: followsGuidance
                  ? 'Ask for dates before searching'
                  : 'Start searching without dates',
                visible_evidence: 'The flight search form is visible.'
              })
            }
          ]
        }
      },
      withSpecialist: async () => {
        throw new Error('A user handoff must not invoke the grounding specialist.')
      },
      activeSpecialistAdapter: () => {
        throw new Error('A user handoff must not load the grounding specialist.')
      }
    })

    const result = await ground({
      goal: 'Find a flight',
      image: screenshot,
      history: [],
      retrievedFacts: [],
      policyHistory: [],
      guidance: queuedGuidance.splice(0),
      coordinateFrame: {
        encoded: { width: 32, height: 24 },
        source: { width: 32, height: 24 }
      }
    })

    expect(result.decision).toMatchObject({
      kind: 'handoff',
      actionText: 'Ask for dates before searching'
    })
    expect(result.modelInput).not.toContain(privateGuidance)
    expect(getTaskRun(taskId)?.steps).toContain(TASK_GUIDANCE_TRACE)
    expect(JSON.stringify(getTaskRun(taskId))).not.toContain(privateGuidance)
  })
})
