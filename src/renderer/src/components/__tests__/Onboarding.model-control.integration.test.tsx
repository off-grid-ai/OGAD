// @vitest-environment jsdom
/**
 * The first run: what you want → which ones → how it works. Real shared data, real storage, the
 * real guide (no model: its own flows answer). Each step, Back and Forward, resume, skip, and
 * everything the old onboarding did (analytics opt-in, Pro key, connections, local or remote).
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Onboarding } from '../Onboarding'
import { ONBOARDING_OPEN_KEY, PICKS_KEY } from '../onboarding/picks'

class TestStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number {
    return this.values.size
  }
  clear(): void {
    this.values.clear()
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const optIn = vi.fn()
const dismissPrompt = vi.fn()
const quickStart = vi.fn()

beforeEach(() => {
  const storage = new TestStorage()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
  optIn.mockReset()
  dismissPrompt.mockReset()
  quickStart.mockReset()
  quickStart.mockResolvedValue({ success: true })
  Object.assign(window, {
    api: {
      // A Mac, so the guide has its Pro features.
      platform: 'darwin',
      embedGuideQuestion: () => Promise.resolve(null),
      askGuide: () => Promise.resolve({ error: 'no-model' }),
      analytics: { optIn, dismissPrompt },
      // The main-process quick start (the IPC boundary): it downloads the starter chat model.
      setupQuickStart: quickStart,
      // Back and Forward (the IPC boundary): main owns Cmd+[ and Cmd+] (the menu on the Mac, the
      // input hook elsewhere) and sends 'navigate:history', so the page never sees the keydown.
      onHistoryNavigate: (cb: (direction: 'back' | 'forward') => void): (() => void) => {
        const onKey = (event: KeyboardEvent): void => {
          if (!(event.metaKey || event.ctrlKey)) return
          if (event.key === '[') cb('back')
          else if (event.key === ']') cb('forward')
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }
    },
    matchMedia: (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined
    })
  })
})

afterEach(cleanup)

const saved = (): { groups: string[]; parts: string[] } =>
  JSON.parse(localStorage.getItem(PICKS_KEY) ?? 'null')
const checked = (testId: string): string | null =>
  screen.getByTestId(testId).getAttribute('aria-checked')
const button = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name })

async function toGroups(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(button('Continue'))
  await screen.findByText('What do you want to do?')
}

describe('desktop onboarding: what you want → which ones → how it works', () => {
  it('starts with Chat picked, and picking a group picks its first feature', async () => {
    const user = userEvent.setup()
    render(<Onboarding onComplete={vi.fn()} />)
    await toGroups(user)
    expect(checked('onboarding-group-chat')).toBe('true')
    // The desktop offers all seven groups; Remember and Meetings are desktop's own.
    expect(screen.getByTestId('onboarding-group-remember')).toBeTruthy()
    expect(screen.getByTestId('onboarding-group-meetings')).toBeTruthy()

    await user.click(screen.getByTestId('onboarding-group-write'))
    expect(checked('onboarding-group-write')).toBe('true')
    expect(saved().groups).toEqual(['chat', 'write'])
    expect(saved().parts).toContain('dictation')

    await user.click(button(/^Continue/))
    await screen.findByText('Which ones?')
    expect(checked('onboarding-part-chat')).toBe('true')
    expect(checked('onboarding-part-dictation')).toBe('true')
    expect(checked('onboarding-part-scribe')).toBe('false')
    // Meetings was not picked, so its features are not offered.
    expect(screen.queryByTestId('onboarding-part-meetings')).toBeNull()
  })

  it('a picked Pro feature offers the license key on the details step', async () => {
    const user = userEvent.setup()
    render(<Onboarding onComplete={vi.fn()} />)
    await toGroups(user)
    await user.click(button(/^Continue/))
    await screen.findByText('Which ones?')
    expect(screen.queryByTestId('onboarding-have-pro')).toBeNull()

    await user.click(button('Back'))
    await user.click(await screen.findByTestId('onboarding-group-meetings'))
    await user.click(button(/^Continue/))
    await screen.findByText('Which ones?')
    expect(screen.getByTestId('onboarding-have-pro').textContent).toMatch(/Enter your license key/)
  })

  it('nothing picked: Continue waits for a pick', async () => {
    const user = userEvent.setup()
    render(<Onboarding onComplete={vi.fn()} />)
    await toGroups(user)
    await user.click(screen.getByTestId('onboarding-group-chat'))
    expect(button(/^Continue/).hasAttribute('disabled')).toBe(true)
    await user.click(screen.getByTestId('onboarding-group-create'))
    expect(button(/^Continue/).hasAttribute('disabled')).toBe(false)
  })

  it('how it works shows the guide for the picks, with Pro, connections, where and analytics', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    render(<Onboarding onComplete={onComplete} />)
    await toGroups(user)
    await user.click(screen.getByTestId('onboarding-group-work'))
    await user.click(button(/^Continue/))
    await screen.findByText('Which ones?')
    await user.click(screen.getByTestId('onboarding-part-integrations'))
    await user.click(button('Show me how it works'))

    expect(await screen.findByText('Your picks')).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: 'Features' })
    expect(nav.textContent).toMatch(/Chat/)
    // The where-it-runs line and the opt-in, both kept from the old last step.
    expect(screen.getByTestId('onboarding-where').textContent).toMatch(
      /Sync never copies its API keys to your phone/
    )
    expect(
      screen.getByRole('checkbox', { name: 'Share anonymous stats and crash reports' })
    ).toBeTruthy()

    await user.click(
      screen.getByRole('checkbox', { name: 'Share anonymous stats and crash reports' })
    )
    await user.click(button('Set up my models'))
    expect(onComplete).toHaveBeenCalledOnce()
    // Set up my models starts the starter chat model at once, so the first reply is minutes away.
    expect(quickStart).toHaveBeenCalledOnce()
    expect(sessionStorage.getItem('first_run_session')).toBe('true')
    expect(optIn).toHaveBeenCalledWith('setup')
    expect(localStorage.getItem('onboarding_completed')).toBe('true')
    expect(localStorage.getItem('onboarding_step')).toBeNull()
    expect(saved().parts).toEqual(expect.arrayContaining(['chat', 'integrations']))
  })

  it('a Pro feature in how it works offers Get Pro and the license key', async () => {
    localStorage.setItem(PICKS_KEY, JSON.stringify({ groups: ['meetings'], parts: ['meetings'] }))
    localStorage.setItem('onboarding_step', 'guide')
    const user = userEvent.setup()
    render(<Onboarding onComplete={vi.fn()} />)
    const offer = await screen.findByTestId('onboarding-pro-offer')
    expect(offer.textContent).toMatch(/\$119 once or \$7\.99 a month/)
    await user.click(button('Enter license key'))
    expect(screen.getByPlaceholderText('key/...')).toBeTruthy()
  })

  it('Back, Cmd+[ and Cmd+] move between steps already reached, never past them', async () => {
    const user = userEvent.setup()
    render(<Onboarding onComplete={vi.fn()} />)
    await toGroups(user)
    await user.click(button(/^Continue/))
    await screen.findByText('Which ones?')
    await user.keyboard('{Meta>}[[{/Meta}')
    await screen.findByText('What do you want to do?')
    await user.keyboard('{Meta>}]{/Meta}')
    await screen.findByText('Which ones?')
    await user.keyboard('{Meta>}]{/Meta}')
    // How it works was never reached, so Forward stays here.
    await waitFor(() => expect(screen.getByText('Which ones?')).toBeTruthy())
    expect(screen.queryByText('Your picks')).toBeNull()
  })

  it('resumes at the saved step with the saved picks, and maps steps from older versions', async () => {
    localStorage.setItem(PICKS_KEY, JSON.stringify({ groups: ['create'], parts: ['images'] }))
    localStorage.setItem('onboarding_step', 'features')
    const { unmount } = render(<Onboarding onComplete={vi.fn()} />)
    await screen.findByText('Which ones?')
    expect(checked('onboarding-part-images')).toBe('true')
    unmount()

    // An older version left people on its Sync step: they resume on the details.
    localStorage.setItem('onboarding_step', 'sync')
    render(<Onboarding onComplete={vi.fn()} />)
    expect(await screen.findByText('Which ones?')).toBeTruthy()
  })

  it('skip leaves no picks, so model setup does what it did before, and analytics asks later', async () => {
    const user = userEvent.setup()
    const onComplete = vi.fn()
    render(<Onboarding onComplete={onComplete} />)
    await toGroups(user)
    await user.click(screen.getByTestId('onboarding-group-create'))
    await user.click(button("Skip, I'll set it up"))
    expect(onComplete).toHaveBeenCalledOnce()
    expect(localStorage.getItem(PICKS_KEY)).toBeNull()
    expect(localStorage.getItem('onboarding_completed')).toBe('true')
    expect(optIn).not.toHaveBeenCalled()
    expect(dismissPrompt).not.toHaveBeenCalled()
  })

  it('an Open in the guide finishes setup and leaves the screen for the app to open', async () => {
    localStorage.setItem(PICKS_KEY, JSON.stringify({ groups: ['create'], parts: ['images'] }))
    localStorage.setItem('onboarding_step', 'guide')
    const user = userEvent.setup()
    const onComplete = vi.fn()
    render(<Onboarding onComplete={onComplete} />)
    await user.click(await screen.findByRole('button', { name: /^Open / }))
    // Images first checks for an image model (Models when there is none), then leaves.
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce())
    expect(localStorage.getItem(ONBOARDING_OPEN_KEY)).toBeTruthy()
  })

  it('a pick this platform does not have yet still shows, with a line saying so', async () => {
    ;(window as unknown as { api: { platform: string } }).api.platform = 'unknown'
    localStorage.setItem(PICKS_KEY, JSON.stringify({ groups: ['meetings'], parts: ['meetings'] }))
    localStorage.setItem('onboarding_step', 'guide')
    render(<Onboarding onComplete={vi.fn()} />)
    expect(await screen.findByTestId('onboarding-not-here')).toBeTruthy()
    expect(screen.getByRole('navigation', { name: 'Features' }).textContent).toMatch(/Meetings/)
  })
})
