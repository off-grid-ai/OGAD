// Build/native/packaging tests: they spawn a real build script or need packaged
// artifacts, so they only pass in a build-capable job — NOT the pure `verify`
// runner. Kept in their own project so verify (product-integration + coverage)
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
  'src/main/__tests__/model-server-team-drain.integration.test.ts',
  'src/main/__tests__/model-server-team-mode.integration.test.ts',
  'src/main/__tests__/model-server-team-runtimes.integration.test.ts',
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

export function createVitestProjects(
  productTestFiles: string[],
  commonExcludes: string[]
): VitestProjectDefinition[] {
  return [
    {
      extends: true,
      test: {
        name: 'product-integration',
        include: productTestFiles,
        exclude: [...commonExcludes, ...modelPortIntegrationTests, ...packagingIntegrationTests],
        sequence: { groupOrder: 0 }
      }
    },
    {
      extends: true,
      test: {
        name: 'model-port-integration',
        include: modelPortIntegrationTests,
        exclude: commonExcludes,
        fileParallelism: false,
        sequence: { groupOrder: 1 }
      }
    },
    {
      extends: true,
      test: {
        name: 'packaging-integration',
        include: packagingIntegrationTests,
        exclude: commonExcludes,
        fileParallelism: false,
        sequence: { groupOrder: 2 }
      }
    }
  ]
}
