import { afterEach, describe, expect, it, vi } from 'vitest'
import { LLMService } from '../../llm'

afterEach(() => vi.restoreAllMocks())

describe('model switch during startup', () => {
  it('waits for the cancelled load, then starts a fresh load', async () => {
    const service = new LLMService()
    const internals = service as unknown as { _doInit(): Promise<void> }
    let finish!: () => void
    const first = new Promise<void>((resolve) => {
      finish = resolve
    })
    const load = vi
      .spyOn(internals, '_doInit')
      .mockImplementationOnce(() => first)
      .mockResolvedValue(undefined)
    const oldLoad = service.init()
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
    service.stop()
    const newLoad = service.init()
    expect(load).toHaveBeenCalledTimes(1)
    finish()
    await Promise.all([oldLoad, newLoad])
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('does not try another engine after the current load is cancelled', async () => {
    const service = new LLMService()
    const internals = service as unknown as {
      launchWithFallback(paths: string[]): Promise<boolean>
      launchServer(path: string, args: string[], layers: number): Promise<boolean>
      launchArgsFor(context: number, layers: number): string[]
      prepareModelPort(): Promise<void>
    }
    vi.spyOn(internals, 'launchArgsFor').mockReturnValue([])
    const launch = vi.spyOn(internals, 'launchServer').mockImplementation(async () => {
      service.stop()
      return false
    })
    const prepare = vi.spyOn(internals, 'prepareModelPort').mockResolvedValue(undefined)
    await expect(internals.launchWithFallback(['/old/server', '/old/fallback'])).resolves.toBe(
      false
    )
    expect(launch).toHaveBeenCalledTimes(1)
    expect(prepare).not.toHaveBeenCalled()
  })
})
