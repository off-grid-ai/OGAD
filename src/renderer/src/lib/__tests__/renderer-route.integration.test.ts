import { expect, it } from 'vitest'
import { JSDOM } from 'jsdom'
import { rendererRoute, rendererRouteTarget, replaceRendererRoute } from '../renderer-route'

it('keeps the file document reloadable and restores the route from its saved URL', () => {
  const url = 'file:///Applications/Off%20Grid.app/out/renderer/index.html'
  const location = new URL(url)
  expect(rendererRoute(location, '/')).toBe('/')
  const saved = new URL(rendererRouteTarget(location, '/chat'), location)
  expect(saved.href).toBe(`${url}#/chat`)
  expect(saved.pathname).toBe(location.pathname)
  const reopened = new URL(saved.href)
  expect(rendererRoute(reopened, '/')).toBe('/chat')
  expect(new URL(rendererRouteTarget(reopened, '/models/embedding'), reopened).href).toBe(
    `${url}#/models/embedding`
  )
})
it('keeps development routes in the pathname', () => {
  const page = new JSDOM('', { url: 'http://localhost:5173/day' })
  replaceRendererRoute(page.window.location, page.window.history, '/chat')
  expect(page.window.location.href).toBe('http://localhost:5173/chat')
  expect(rendererRoute(page.window.location)).toBe('/chat')
  page.window.close()
})
