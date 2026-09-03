import { defineConfig } from 'eslint/config'
import tseslint from '@electron-toolkit/eslint-config-ts'
import eslintConfigPrettier from '@electron-toolkit/eslint-config-prettier'
import eslintPluginReact from 'eslint-plugin-react'
import eslintPluginReactHooks from 'eslint-plugin-react-hooks'
import eslintPluginReactRefresh from 'eslint-plugin-react-refresh'
import sonarjs from 'eslint-plugin-sonarjs'
import tsESLint from 'typescript-eslint'

// Typed dead-BRANCH gate: no-unnecessary-condition uses the type-checker to flag
// conditions that are always truthy/falsy given the types — the exact AI pattern
// (defensive `if (x && x.y)` after x is already non-null, dead `===` branches,
// `x?.y` where x can't be null). Requires typed linting (projectService). The
// backlog is fully ground to zero, so this is now ERROR: a new dead branch fails
// the build. When the fix is a legit guard at an untyped boundary (JSON.parse /
// IPC / external data), correct the TYPE so the guard becomes necessary — do NOT
// weaken this back to warn or blanket-disable. Never auto-fixed (suggestion-only).
// Scoped to the dirs the tsconfigs cover so projectService never errors on a stray file.
const typedDeadBranchWarn = {
  name: 'typed no-unnecessary-condition (error)',
  files: [
    'src/main/**/*.ts',
    'src/preload/**/*.ts',
    'src/renderer/src/**/*.{ts,tsx}',
    'pro/main/**/*.ts',
    'pro/renderer/**/*.{ts,tsx}'
  ],
  ignores: ['**/*.{test,spec,dbtest}.{ts,tsx}', '**/__tests__/**', '**/*.d.ts'],
  languageOptions: {
    parser: tsESLint.parser,
    parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
  },
  plugins: { '@typescript-eslint': tsESLint.plugin },
  rules: { '@typescript-eslint/no-unnecessary-condition': 'error' }
}

// Hexagonal boundary (warn ratchet, see shared/docs/MODEL_FACADE_PLAN.md): app code composes its
// model layer from the ONE shared facade, `@offgrid/models/workspace`, plus pure catalog constants
// from `@offgrid/models/catalog`. Value imports from the package root are the second pipeline being
// removed; each warning is one migration item. Types stay free. Ratchets to `error` at zero.
const modelBoundaryWarn = {
  name: 'model facade boundary (warn ratchet)',
  files: ['src/**/*.{ts,tsx}', 'pro/**/*.{ts,tsx}'],
  // The composition root is the ONE place shared services are constructed with this app's ports.
  ignores: [
    '**/*.{test,spec,dbtest}.{ts,tsx}',
    '**/__tests__/**',
    '**/*.d.ts',
    'src/main/model-services.ts',
    'src/main/composition/**',
    'src/main/model-selection-persistence.ts',
    'src/renderer/src/composition/**',
    'pro/main/composition/**'
  ],
  plugins: { '@typescript-eslint': tsESLint.plugin },
  rules: {
    // ONE rule entry: a second config block with the same rule id would replace this one (flat
    // config merges per rule id), which silently hid the class 4 queue once.
    '@typescript-eslint/no-restricted-imports': [
      'warn',
      {
        paths: [
          {
            name: '@offgrid/models',
            importNames: ['decodeModelRouteId', 'encodeModelRouteId', 'parseRemoteVisionModelId', 'remoteVisionModelId'],
            message:
              'Class 2: one id space. Ask the workspace for the projection you need instead of decoding route ids in app code.',
            allowTypeImports: true
          },
          {
            name: '@offgrid/models',
            // Constructing a shared service in app code is app-side composition of the pipeline.
            // Services are composed ONCE, in the workspace; the app supplies ports and renders.
            importNames: [
              'ArtifactVerificationService',
              'CaptureReadinessApplicationService',
              'ChatContextApplicationService',
              'ChatModelReadinessService',
              'ChatOperationApplicationService',
              'ChatSessionQueue',
              'ChatSessionService',
              'ClassifierExecutionService',
              'ClassifierProvisioningService',
              'ComputerUseSessionApplicationService',
              'ConnectorDistillApplicationService',
              'ConnectorReadApplicationService',
              'ContextCompactionService',
              'DownloadedModelRegistryService',
              'DownloadOperationRegistry',
              'GenerationCancellationCoordinator',
              'GenerationIntentService',
              'GenerationRecoveryCoordinator',
              'GenerationService',
              'GenerationTurnQueue',
              'ImageArchiveImportService',
              'ImageDownloadApplicationService',
              'ImageDownloadRecoveryService',
              'ImageDownloadWorkflowService',
              'ImageGenerationApplicationService',
              'ImageGenerationJobCoordinator',
              'ImagePromptEnhancementService',
              'LLMService',
              'LoadPolicyTransitionCoordinator',
              'LocalModelImportService',
              'McpConnectorApplicationService',
              'MobileNativeLoadService',
              'MobileTextLoadAdmissionService',
              'ModelActivationService',
              'ModelCommandApplicationService',
              'ModelControlApplicationService',
              'ModelDownloadApplicationService',
              'ModelDownloadCoordinator',
              'ModelDownloadProjectionController',
              'ModelDownloadQueue',
              'ModelDownloadRegistry',
              'ModelEjectionService',
              'ModelFileImportApplicationService',
              'ModelLibraryCommandService',
              'ModelLibraryRegistryService',
              'ModelLibraryRemovalService',
              'ModelLifecycleApplicationService',
              'ModelMemoryAdvisoryService',
              'ModelMetadataRepairCommandService',
              'ModelRepairCommandService',
              'ModelResidencyManager',
              'ModelSelectionApplicationService',
              'ModelSelectionAuthority',
              'ModelTransferRegistrationService',
              'ProactiveActionApplicationService',
              'ProactiveToolCatalogService',
              'RemoteCapabilityDiscoveryApplicationService',
              'RemoteLanDiscoveryApplicationService',
              'RemoteProviderDiscoveryApplicationService',
              'RemoteServerApplicationService',
              'TextEngineApplicationService',
              'ToolRegistry',
              'ToolRoutingService',
              'VisionRepairApplicationService',
              'VoiceApplicationService',
              'VoicePlaybackService'
            ],
            message:
              'Compose shared services through @offgrid/models/workspace, not in app code. Business logic lives in shared; this app is a port.',
            allowTypeImports: true
          }
        ]
      }
    ]
  }
}

// Pipeline decisions live in shared (see MODEL_FACADE_PLAN.md "Defect classes"). Class 1: request
// parameters. Class 3: image MIME / model-file literals. (Class 2, the id codecs, lives in the
// import rule above.) Each warning is one decision to move into shared.
const pipelineDecisionsWarn = {
  name: 'model pipeline decisions (warn ratchet)',
  files: ['src/**/*.{ts,tsx}', 'pro/**/*.{ts,tsx}'],
  ignores: [
    '**/*.{test,spec,dbtest}.{ts,tsx}',
    '**/__tests__/**',
    '**/*.d.ts',
    'src/main/model-services.ts',
    'src/main/composition/**',
    'src/main/model-selection-persistence.ts',
    'src/renderer/src/composition/**',
    'pro/main/composition/**'
  ],
  plugins: { '@typescript-eslint': tsESLint.plugin },
  rules: {
    'no-restricted-syntax': [
      'warn',
      {
        selector:
          "Property[key.name=/^(maxTokens|temperature|topP|thinking|timeoutMs)$/][value.type='Literal']",
        message:
          'Class 1: a generation parameter is a pipeline decision. Use a shared request builder (e.g. imageEnhancementGenerationRequest).'
      },
      {
        selector: "Literal[value=/^image\\/(png|jpe?g|webp)$/]",
        message: 'Class 3: image MIME types are an artifact fact owned by shared.'
      }
    ]
  }
}

// Sonar-grade rules (bugs, cognitive complexity, duplicated branches, dead code)
// scoped to pro/** ONLY. Core src is covered by SonarCloud Automatic Analysis, so
// running sonarjs there too would be redundant — but SonarCloud (public project)
// never sees the private pro submodule, so this is how pro gets the same class of
// checks. pro has no own toolchain; it's linted by this root config. Introduced at
// WARN (ratchet, per CLAUDE.md "Pending hygiene adoption") with sonarjs's purely-
// stylistic / already-owned rules turned off so what's left is real defect signal.
const sonarProWarn = {
  ...sonarjs.configs.recommended,
  name: 'sonarjs on pro (warn ratchet)',
  // Product code only — test files are intentionally explicit/repetitive; linting
  // them for duplicate-string / complexity is noise (SonarCloud separates test from
  // main sources for the same reason). Not suppression — correct scoping.
  files: ['pro/**/*.{ts,tsx}'],
  ignores: ['pro/**/*.{test,spec}.{ts,tsx}', 'pro/**/__tests__/**'],
  rules: {
    ...Object.fromEntries(
      Object.keys(sonarjs.configs.recommended.rules ?? {}).map((rule) => [rule, 'warn'])
    ),
    // Pure style — not a defect:
    'sonarjs/arrow-function-convention': 'off',
    'sonarjs/file-header': 'off',
    'sonarjs/shorthand-property-grouping': 'off',
    'sonarjs/no-wildcard-import': 'off', // `import * as fs/http/path` is intentional here
    'sonarjs/void-use': 'off', // `void promise` is our intentional fire-and-forget idiom
    // Owned by another gate / genuine false positives on this codebase:
    'sonarjs/no-implicit-dependencies': 'off', // dependency-cruiser owns dep boundaries
    'sonarjs/no-reference-error': 'off', // type-unaware; fires on the valid `NodeJS.Timeout` type — tsc is the real ref-error gate
    'sonarjs/publicly-writable-directories': 'off' // os.tmpdir() scratch files are legitimate
  }
}

// Wednesday-solutions gold-standard structural + style rules (CLAUDE.md "Pending hygiene
// adoption", part 2), introduced at WARN as a RATCHET: many current files exceed the caps
// (MemoryChat ~2.6k lines, ipc.ts ~1.7k, …), so failing the build on them now would be
// pointless noise. They surface as warnings and tighten to `error` as the god-files
// decompose — never loosened to pass. `complexity` starts loose (15) per CLAUDE.md and
// ratchets toward the gold standard (5). Product code only; tests are exempt (intentionally
// explicit/repetitive). Formatting is prettier's job (eslintConfigPrettier), not these.
const goldStandardRatchet = {
  name: 'wednesday gold-standard (warn ratchet)',
  files: ['src/**/*.{ts,tsx}', 'pro/**/*.{ts,tsx}'],
  ignores: ['**/*.{test,spec,dbtest}.{ts,tsx}', '**/__tests__/**', '**/*.d.ts'],
  rules: {
    curly: ['warn', 'all'],
    'no-else-return': 'warn',
    'no-empty': 'warn',
    'prefer-template': 'warn',
    'no-console': ['warn', { allow: ['error', 'warn'] }],
    'max-params': ['warn', 3],
    complexity: ['warn', 15],
    'max-lines-per-function': ['warn', 250],
    'max-lines': ['warn', 350],
    '@typescript-eslint/no-shadow': 'warn'
  }
}

const intentionalUnusedParameters = {
  name: 'intentional unused parameters',
  files: ['**/*.{js,mjs,ts,tsx}'],
  rules: {
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_'
      }
    ]
  }
}

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/coverage/**',
      '.claude/**',
      '.offgrid/**',
      '.demo-profile/**',
      'component-library-animations/**',
      'resources/artifacts/**',
      '**/*.min.js',
      '**/*.min.css'
    ]
  },
  tseslint.configs.recommended,
  eslintPluginReact.configs.flat.recommended,
  eslintPluginReact.configs.flat['jsx-runtime'],
  sonarProWarn,
  goldStandardRatchet,
  typedDeadBranchWarn,
  modelBoundaryWarn,
  pipelineDecisionsWarn,
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': eslintPluginReactHooks,
      'react-refresh': eslintPluginReactRefresh
    },
    rules: {
      ...eslintPluginReactHooks.configs.recommended.rules,
      ...eslintPluginReactRefresh.configs.vite.rules
    }
  },
  intentionalUnusedParameters,
  {
    name: 'CommonJS build hooks',
    files: ['scripts/resign.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    name: 'test boundary fakes',
    files: ['**/*.{test,spec,dbtest}.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      // Framework fakes such as ResizeObserver intentionally expose no-op methods.
      '@typescript-eslint/no-empty-function': 'off'
    }
  },
  eslintConfigPrettier
)
