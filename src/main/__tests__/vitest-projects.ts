// Build/native/packaging tests: they spawn a real build script or need packaged
// artifacts, so they only pass in a build-capable job — NOT the pure `verify`
// runner. Kept in their own project so the normal UI and service verification
// stays green and these run in the build job / locally via `npm run test:heavy`.
export const packagingIntegrationTests = [
  'src/main/__tests__/dmg-install-smoke.integration.test.ts',
  'src/main/__tests__/packaged-helpers.integration.test.ts',
  'src/main/__tests__/release-packaging.integration.test.ts',
  // Spawns scripts/build-whisper-cli.sh (real cmake/build staging) — build-env only.
  'src/main/__tests__/whisper-cli-build.integration.test.ts'
]

export const modelPortIntegrationTests = [
  'src/main/__tests__/model-server-chat.integration.test.ts',
  'src/main/__tests__/model-switch-ownership.integration.test.ts',
  'src/renderer/src/components/setup/__tests__/HealthPanel.integration.test.tsx'
]

export interface VitestProjectDefinition {
  extends: true
  test: {
    name: string
    include: string[]
    exclude: string[]
    fileParallelism?: false
    sequence: { groupOrder: number }
  }
}

const coreUiBehaviorTestFiles = ['src/renderer/src/**/*.test.tsx']
const proUiBehaviorTestFiles = ['pro/renderer/**/*.test.tsx']
const coreServiceIntegrationTestFiles = ['integration-tests/*.test.ts', 'src/**/*.test.ts']
const proServiceIntegrationTestFiles = ['pro/**/*.test.ts']

export function createUiBehaviorTestFiles(hasPro: boolean): string[] {
  return [...coreUiBehaviorTestFiles, ...(hasPro ? proUiBehaviorTestFiles : [])]
}

/**
 * Desktop core and Desktop Pro always join the same product project. The canonical `npm test`
 * also selects the database project in that same Vitest invocation.
 */
export function createProductTestFiles(hasPro: boolean): string[] {
  return [...coreServiceIntegrationTestFiles, ...(hasPro ? proServiceIntegrationTestFiles : [])]
}

export function createVitestProjects(
  uiBehaviorTestFiles: string[],
  productTestFiles: string[],
  commonExcludes: string[]
): VitestProjectDefinition[] {
  return [
    {
      extends: true,
      test: {
        name: 'ui-behavior-integration',
        include: uiBehaviorTestFiles,
        exclude: commonExcludes,
        sequence: { groupOrder: 0 }
      }
    },
    {
      extends: true,
      test: {
        name: 'service-integration',
        include: productTestFiles,
        exclude: [...commonExcludes, ...modelPortIntegrationTests, ...packagingIntegrationTests],
        sequence: { groupOrder: 1 }
      }
    },
    {
      extends: true,
      test: {
        name: 'model-port-integration',
        include: modelPortIntegrationTests,
        exclude: commonExcludes,
        fileParallelism: false,
        sequence: { groupOrder: 2 }
      }
    },
    {
      extends: true,
      test: {
        name: 'packaging-integration',
        include: packagingIntegrationTests,
        exclude: commonExcludes,
        fileParallelism: false,
        sequence: { groupOrder: 3 }
      }
    }
  ]
}
