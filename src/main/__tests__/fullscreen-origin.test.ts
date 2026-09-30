import { expect, it } from 'vitest'
import { fullscreenOriginAllowed } from '../fullscreen-origin'

const file =
  'file:///Applications/Off%20Grid.app/Contents/Resources/app.asar/out/renderer/index.html'
it('admits a saved file player across route hashes', () => {
  expect(fullscreenOriginAllowed(file, file, `${file}#/chat`, `${file}#/chat`)).toBe(true)
  expect(fullscreenOriginAllowed(file, `${file}#/day`, `${file}#/chat`, file)).toBe(true)
})
it('denies foreign files, query changes and missing trusted documents', () => {
  expect(fullscreenOriginAllowed(file, file, `${file}#/chat`, 'file:///tmp/player.html')).toBe(
    false
  )
  expect(fullscreenOriginAllowed(file, 'file:///tmp/player.html', file, file)).toBe(false)
  expect(fullscreenOriginAllowed(file, `${file}?other=1`, file, file)).toBe(false)
  expect(fullscreenOriginAllowed(file, '', file, file)).toBe(false)
})
it('admits dev routes on the renderer origin and rejects other origins and invalid URLs', () => {
  const dev = 'http://localhost:5173'
  expect(fullscreenOriginAllowed(dev, dev, `${dev}/chat`, `${dev}/chat`)).toBe(true)
  expect(fullscreenOriginAllowed(dev, dev, `${dev}/chat`, 'http://localhost:5174/chat')).toBe(false)
  expect(fullscreenOriginAllowed(dev, dev, `${dev}/chat`, 'not a URL')).toBe(false)
})
