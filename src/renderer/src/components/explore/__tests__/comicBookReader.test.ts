import { describe, expect, it } from 'vitest'
import {
  buildComicBookReader,
  comicBookHeroImage,
  comicBookPageFromPrompt,
  comicBookPageCount,
  comicBookTitle
} from '../comicBookReader'

describe('comic book reader', () => {
  it('reads the approved page count from the preset prompt', () => {
    expect(comicBookPageCount('Q: Story length\nA: 24 distinct images')).toBe(24)
    expect(comicBookPageCount('Q: Story length\nA: 9 distinct images')).toBeNull()
    expect(comicBookPageCount('Q: Story length\nA: 101 distinct images')).toBeNull()
  })

  it('reads an optional local hero reference without treating an empty answer as a path', () => {
    expect(comicBookHeroImage('Q: Hero reference image\nA: /Users/me/hero.png')).toBe(
      '/Users/me/hero.png'
    )
    expect(comicBookHeroImage('Q: Hero reference image\nA: Not provided')).toBeNull()
  })

  it('separates visible story text from illustration directions', () => {
    expect(
      comicBookPageFromPrompt(
        'PAGE STORY: Volt finds the damaged relay. "We still have time," he says.\nILLUSTRATION: Page 3, two panels, cyan lightning.'
      )
    ).toEqual({
      story: 'Volt finds the damaged relay. "We still have time," he says.',
      prompt: 'Page 3, two panels, cyan lightning.'
    })
  })

  it('uses the planned book title and falls back to a concise story brief', () => {
    expect(comicBookTitle('BOOK TITLE: The Last Relay\nPAGE STORY: The storm arrives.')).toBe(
      'The Last Relay'
    )
    expect(
      comicBookTitle(
        'Q: Story brief\nA: A retired lunar courier crosses a flooded city to deliver one last letter.'
      )
    ).toBe('A retired lunar courier crosses a flooded city')
  })

  it('renders completed pages and keeps the expected total visible while generation continues', () => {
    const html = buildComicBookReader(
      [
        {
          src: 'ogcapture:///generated/page-1.png',
          story: 'The courier finds the letter.',
          prompt: 'Opening scene'
        },
        {
          src: 'ogcapture:///generated/page-2.png',
          story: 'The chase begins.',
          prompt: 'The chase begins'
        }
      ],
      10,
      'The Last Relay'
    )

    expect(html).toContain('2 / 10 PAGES')
    expect(html).toContain('<title>The Last Relay</title>')
    expect(html).toContain('<strong>THE LAST RELAY</strong>')
    expect(html).toContain('ogcapture:///generated/page-1.png')
    expect(html).toContain('ogcapture:///generated/page-2.png')
    expect(html).toContain('The courier finds the letter.')
    expect(html).toContain('aria-label="Story for page 1"')
    expect(html).toContain('<section class="notes" aria-label="Page notes"><span>PAGE NOTES</span>')
    expect(html).not.toContain('<details')
    expect(html).toContain('ArrowLeft')
    expect(html).toContain('ArrowDown')
    expect(html).toContain('aria-label="Read aloud controls"')
    expect(html).toContain('id="speech-language"')
    expect(html).toContain('id="speech-model"')
    expect(html).toContain('id="speech-voice"')
    expect(html).toContain("__ogComicTts:'model'")
    expect(html).toContain("__ogComicTts:'catalog'")
    expect(html).toContain("__ogComicTts:'speak'")
    expect(html).toContain("data.reason==='ended'")
    expect(html).toContain('show(current+1)')
    expect(html).toContain("fetch(gatewayBase+'/audio/voices')")
    expect(html).toContain("fetch(gatewayBase+'/audio/speech'")
    expect(html).toContain('if(window===parent){void connectGateway()}')
    expect(html).toContain('.stage{min-height:0;overflow:hidden')
    expect(html).toContain('aria-live="polite"')
  })

  it('escapes page notes before placing them in the reader', () => {
    const html = buildComicBookReader(
      [
        {
          src: 'ogcapture:///generated/page.png',
          story: '<script>story()</script>',
          prompt: '<script>bad()</script>'
        }
      ],
      10
    )

    expect(html).not.toContain('<script>bad()</script>')
    expect(html).not.toContain('<script>story()</script>')
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
    expect(html).toContain('&lt;script&gt;story()&lt;/script&gt;')
  })
})
