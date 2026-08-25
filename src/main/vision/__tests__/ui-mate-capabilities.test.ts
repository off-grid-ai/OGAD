import { describe, expect, it } from 'vitest'
import {
  assertUIMateModelCapabilities,
  UI_MATE_GGUF_REPOSITORY
} from '../model-adapters/ui-mate/capabilities'
import { loadGatedVisionModelAdapter, resolveVisionModelAdapter } from '../model-adapters/registry'

const primary = 'tencent_UI-Mate-9B-Q4_K_M.gguf'
const projector = 'mmproj-tencent_UI-Mate-9B-f16.gguf'

describe('UI-Mate model capability gate', () => {
  it('selects UI-Mate through the shared registry and preserves UI-TARS separately', () => {
    const uiMate = {
      id: UI_MATE_GGUF_REPOSITORY,
      primaryFile: primary,
      projectorFile: projector,
      availableFiles: [primary, projector]
    }
    expect(resolveVisionModelAdapter(uiMate).id).toBe('ui-mate')
    expect(loadGatedVisionModelAdapter(uiMate)?.id).toBe('ui-mate')

    const uiTars = {
      id: 'local/ui-tars',
      primaryFile: 'ui-tars.gguf',
      projectorFile: 'mmproj-ui-tars.gguf',
      availableFiles: ['ui-tars.gguf', 'mmproj-ui-tars.gguf']
    }
    expect(resolveVisionModelAdapter(uiTars).id).toBe('ui-tars')
    expect(loadGatedVisionModelAdapter(uiTars)).toBeNull()
  })

  it('accepts the official GGUF family with either matching projector', () => {
    expect(
      assertUIMateModelCapabilities({
        repositoryId: UI_MATE_GGUF_REPOSITORY,
        primaryFile: primary,
        projectorFile: projector,
        availableFiles: [primary, projector]
      })
    ).toEqual({
      repositoryId: UI_MATE_GGUF_REPOSITORY,
      primaryFile: primary,
      projectorFile: projector
    })
  })

  it.each([
    {
      label: 'wrong repository',
      value: {
        repositoryId: 'someone/other',
        primaryFile: primary,
        projectorFile: projector,
        availableFiles: [primary, projector]
      }
    },
    {
      label: 'wrong weights',
      value: {
        repositoryId: UI_MATE_GGUF_REPOSITORY,
        primaryFile: 'another-model.gguf',
        projectorFile: projector,
        availableFiles: ['another-model.gguf', projector]
      }
    },
    {
      label: 'no projector',
      value: {
        repositoryId: UI_MATE_GGUF_REPOSITORY,
        primaryFile: primary,
        availableFiles: [primary]
      }
    },
    {
      label: 'wrong projector family',
      value: {
        repositoryId: UI_MATE_GGUF_REPOSITORY,
        primaryFile: primary,
        projectorFile: 'mmproj-other-f16.gguf',
        availableFiles: [primary, 'mmproj-other-f16.gguf']
      }
    },
    {
      label: 'projector absent on disk',
      value: {
        repositoryId: UI_MATE_GGUF_REPOSITORY,
        primaryFile: primary,
        projectorFile: projector,
        availableFiles: [primary]
      }
    }
  ])('rejects $label before inference', ({ value }) => {
    expect(() => assertUIMateModelCapabilities(value)).toThrow(/UI-Mate/)
  })
})
