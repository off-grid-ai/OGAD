import { describe, expect, it, vi } from 'vitest'
import { llm } from '../../llm'
import { browserVisionStepDetail, resolveActiveBrowserVisionAdapter } from '../browser-visual-task'

describe('browser visual task boundary', () => {
  it('keeps the captured screenshot and structured judge evidence in task details', () => {
    const detail = browserVisionStepDetail(
      {
        step: 4,
        phase: 'checking',
        promptContext: 'judge request',
        screenshot: {
          image: '/private/task/frame-4.png',
          bounds: { width: 1200, height: 800 },
          metadata: {
            path: '/private/task/frame-4.png',
            viewport: { width: 1000, height: 700 },
            geometry: {
              sourceBounds: { x: 20, y: 30, width: 1000, height: 700 },
              encodedSize: { width: 1200, height: 840 },
              scale: 1.2
            }
          }
        },
        retrievedFacts: [],
        rawResponse: '{"verdict":"complete"}',
        decisionSummary: 'The current milestone is complete.',
        decisionRationale: 'The requested page is visible.',
        durationMs: 3200,
        result: 'terminal'
      },
      { id: 'mac-1', name: 'This Mac' },
      1234
    )

    expect(detail).toMatchObject({
      stepId: '4',
      at: 1234,
      rawResponse: '{"verdict":"complete"}',
      screenshot: {
        path: '/private/task/frame-4.png',
        availability: 'device_local',
        executionDeviceId: 'mac-1',
        originalWidth: 1000,
        originalHeight: 700,
        inferenceWidth: 1200,
        inferenceHeight: 840,
        viewportWidth: 1000,
        viewportHeight: 700
      }
    })
  })

  it('labels proposed model points as inference coordinates', () => {
    const detail = browserVisionStepDetail(
      {
        step: 2,
        phase: 'thinking',
        promptContext: 'action request',
        screenshot: {
          image: '/private/task/frame.png',
          bounds: { width: 832, height: 1024 },
          metadata: {
            path: '/private/task/frame.png',
            viewport: { width: 532, height: 658 },
            geometry: {
              sourceBounds: { x: 0, y: 0, width: 1064, height: 1316 },
              encodedSize: { width: 832, height: 1024 },
              scale: 832 / 1064
            }
          }
        },
        retrievedFacts: [],
        parsedAction: { type: 'click', point: { x: 119, y: 799 } },
        durationMs: 100,
        result: 'reviewed'
      },
      { id: 'mac-1', name: 'This Mac' }
    )

    expect(detail.actionCoordinateSpace).toBe('inference')
  })

  it('labels executed browser points as viewport coordinates', () => {
    const detail = browserVisionStepDetail(
      {
        step: 2,
        phase: 'acting',
        promptContext: 'action request',
        screenshot: {
          image: '/private/task/frame.png',
          bounds: { width: 832, height: 1024 },
          metadata: {
            path: '/private/task/frame.png',
            viewport: { width: 532, height: 658 },
            geometry: {
              sourceBounds: { x: 0, y: 0, width: 1064, height: 1316 },
              encodedSize: { width: 832, height: 1024 },
              scale: 832 / 1064
            }
          }
        },
        retrievedFacts: [],
        parsedAction: { type: 'click', point: { x: 119, y: 799 } },
        mappedAction: { type: 'click', point: { x: 76, y: 513 } },
        durationMs: 100,
        result: 'actuated'
      },
      { id: 'mac-1', name: 'This Mac' }
    )

    expect(detail.actionCoordinateSpace).toBe('viewport')
  })

  it('fails clearly instead of falling back to DOM control when vision is unavailable', () => {
    vi.spyOn(llm, 'activeModelArtifacts').mockReturnValue(null)

    expect(() => resolveActiveBrowserVisionAdapter()).toThrow(
      'Web Use requires an active model with installed vision support.'
    )
  })
})
