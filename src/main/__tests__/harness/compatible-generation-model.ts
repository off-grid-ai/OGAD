import { installFakeActiveTextModel } from './fake-llama-server'

/**
 * Refresh the real application inventory after a test changes native model facts.
 *
 * Native-boundary journeys create tiny files and a live fake engine instead of installing a full
 * model. The production Desktop adapters read those boundary facts. Tests must not register a
 * second inventory or generation control plane beside the shared workspace.
 */
export async function installCompatibleGenerationModel(): Promise<() => void> {
  // Import after the test module has installed its Electron/native boundary fakes.
  // A setup-file top-level import would lock in the real Electron module before
  // vi.mock is applied and make database paths unavailable in the test worker.
  await import('../../composition/application')
  const { desktopModels } = await import('../../composition/application-access')
  await desktopModels.refresh()
  return () => undefined
}

/**
 * Make the REAL local text route ready over a fake llama-server. Pins the data dir, installs the
 * durable fake model selection, marks the engine up, and registers the compatible route - the
 * whole boundary a CRM/LLM journey needs. Tests that only poked the engine's port were green on
 * machines with a real model installed and red in CI ("No compatible text model is ready").
 */
export async function readyFakeLocalTextModel(
  fake: { port: number },
  dataDir: string
): Promise<() => void> {
  const previousDataDir = process.env.OFFGRID_DATA_DIR
  process.env.OFFGRID_DATA_DIR = dataDir
  const [{ configureRuntime }, { llm }] = await Promise.all([
    import('../../runtime-env'),
    import('../../llm')
  ])
  configureRuntime({ dataDir })
  installFakeActiveTextModel(dataDir)
  const engine = llm as unknown as { port: number; initialized: boolean; paused: boolean }
  engine.port = fake.port
  engine.initialized = true
  engine.paused = false
  const uninstall = await installCompatibleGenerationModel()
  return () => {
    uninstall()
    configureRuntime({ dataDir: undefined })
    if (previousDataDir === undefined) delete process.env.OFFGRID_DATA_DIR
    else process.env.OFFGRID_DATA_DIR = previousDataDir
  }
}
