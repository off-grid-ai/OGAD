import { afterAll } from 'vitest'

/**
 * Leave the model port free for the next file.
 *
 * The db suite runs serially but inside ONE process, so a file that starts the chat engine and does not
 * stop it hands the next file a bound port. That surfaced as failures with nothing to do with the test
 * that reported them: an EADDRINUSE on 8439 while a journey was spawning its own fake engine, and a
 * "runtime boundary still owns port" assertion watching a port a neighbour owned. Both looked like
 * defects in the file that happened to run next.
 *
 * A per-file teardown fixes it once, for every file, instead of each test remembering. It stops the llm
 * singleton if this file created one - dynamically imported, and only if the module was actually loaded,
 * so a file that never touches the engine pays nothing and no file gains an import it did not ask for.
 *
 * Registered from vitest.db.config.ts as a setup file, so it applies to the whole suite.
 */
afterAll(async () => {
  try {
    const { llm } = await import('../../llm')
    llm.stop()
  } catch {
    // The file never loaded the engine, or the module graph is already torn down. Either way there is
    // nothing holding the port on this file's behalf.
  }
})
