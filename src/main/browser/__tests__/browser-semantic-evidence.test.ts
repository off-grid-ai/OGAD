import { describe, expect, it } from 'vitest'
import { browserSemanticStepDetail } from '../browser-semantic-evidence'

describe('semantic Web Use replay evidence', () => {
  it('projects a semantic page frame into the shared bounded replay schema', () => {
    const detail = browserSemanticStepDetail({
      observation: { step: 3, phase: 'checking', summary: 'Opened the receipt' },
      screenshot: {
        image: '/private/task/semantic-3.png',
        bounds: { width: 1200, height: 750 },
        metadata: {
          path: '/private/task/semantic-3.png',
          viewport: { width: 1920, height: 1200 },
          geometry: {
            sourceBounds: { x: 0, y: 0, width: 1920, height: 1200 },
            encodedSize: { width: 1200, height: 750 },
            scale: 0.625
          }
        }
      },
      executionDevice: { id: 'desktop-1', name: 'This Mac' },
      at: 1234
    })

    expect(detail).toEqual({
      stepId: 'semantic-3-checking',
      at: 1234,
      phase: 'checking',
      screenshot: {
        path: '/private/task/semantic-3.png',
        availability: 'device_local',
        executionDeviceId: 'desktop-1',
        executionDeviceName: 'This Mac',
        originalWidth: 1920,
        originalHeight: 1200,
        inferenceWidth: 1200,
        inferenceHeight: 750,
        viewportWidth: 1920,
        viewportHeight: 1200
      },
      decisionSummary: 'Opened the receipt',
      execution: { status: 'complete', result: 'semantic page observed' }
    })
  })
})
