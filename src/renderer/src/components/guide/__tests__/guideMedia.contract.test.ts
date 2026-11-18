/**
 * Contract: every feature the guide shows has a picture. A topic page with only an icon in a grey box
 * reads as unfinished (Mac, 18 Nov 2026). This fails when a topic is added without a GUIDE_MEDIA entry.
 */
import { describe, expect, it } from 'vitest'
import { guideTopics } from '../guideKnowledge'

describe('guide pictures', () => {
  for (const platform of ['darwin', 'win32', 'linux'] as const) {
    it(`every topic on ${platform} has a picture`, () => {
      const missing = guideTopics(platform)
        .filter((t) => !t.media)
        .map((t) => t.id)
      expect(missing).toEqual([])
    })
  }
})
