import { describe, expect, it } from 'vitest'
import { windowsOcrScript } from '../windows-ocr'

describe('Windows.Media.Ocr adapter contract', () => {
  it('uses the installed user-profile language and returns pixel word bounds', () => {
    const script = windowsOcrScript("C:\\fixtures\\O'Brien.png")
    expect(script).toContain('Windows.Media.Ocr.OcrEngine')
    expect(script).toContain('TryCreateFromUserProfileLanguages')
    expect(script).toContain('No Windows OCR language is installed.')
    expect(script).toContain('BoundingRect')
    expect(script).toContain('width=[int]$r.Width')
    expect(script).toContain("'C:\\fixtures\\O''Brien.png'")
  })
})
