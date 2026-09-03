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
// removed. Types stay free. The queue reached zero on 2026-09-02 and the rule is now an error.
const modelBoundaryWarn = {
  name: 'model facade boundary (error)',
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
      'error',
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
              'GatewayAsyncRequestStore',
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
// parameters. Class 3: image MIME / model-file literals. Class 4: shared services constructed
// outside a composition root. (Class 2, the id codecs, lives in the import rule above.) Each hit is
// one decision to move into shared or into a root.
const boundaryRootIgnores = [
  '**/*.{test,spec,dbtest}.{ts,tsx}',
  '**/__tests__/**',
  '**/*.d.ts',
  'src/main/model-services.ts',
  'src/main/composition/**',
  'src/main/model-selection-persistence.ts',
  'src/renderer/src/composition/**',
  'pro/main/composition/**'
]

const pipelineDecisionSelectors = [
  {
    selector:
      "Property[key.name=/^(maxTokens|temperature|topP|timeoutMs)$/][value.type='Literal'], Property[key.name='thinking'][value.type='Literal'][value.raw=/^(true|false)$/]",
    message:
      'Class 1: a generation parameter is a pipeline decision. Use a shared request builder (e.g. imageEnhancementGenerationRequest).'
  },
  {
    selector: "Literal[value=/^image\\/(png|jpe?g|webp)$/]",
    message: 'Class 3: image MIME types are an artifact fact owned by shared.'
  },
  {
    selector: "Literal[value=/\\.(gguf|safetensors)$/i], Literal[regex.pattern=/\\\\.(gguf|safetensors)/]",
    message: 'Class 3: model file types are an artifact fact owned by shared (isGgufFile, MODEL_FILE_EXTENSION).'
  }
]

// Widened 2026-09-03 (HEXAGONAL_AUDIT_2026-09-03b move 1). Route policy, image sampling knobs,
// arithmetic timeouts, and default-parameter values are the same class of decision as a literal.
const widenedPipelineDecisionSelectors = [
  {
    selector:
      "Property[key.name=/^(allowFallback|partialOutputPolicy|steps|cfg|sampler|seed)$/][value.type='Literal']",
    message:
      'Class 1: route policy and image sampling are profile facts. Name a generation profile (or a shared image settings rule) instead of a literal.'
  },
  {
    selector:
      "Property[key.name=/^(maxTokens|temperature|topP|timeoutMs)$/][value.type='BinaryExpression'], AssignmentPattern[left.name=/^(maxTokens|temperature|topP|timeoutMs)$/][right.type=/^(Literal|BinaryExpression|UnaryExpression)$/]",
    message:
      'Class 1: a computed or defaulted generation parameter is still a pipeline decision. Name a generation profile or read the shared runtime policy.'
  },
  {
    // A service class or create* factory (service-like suffix) imported as a VALUE from a shared
    // service package is constructed only in a composition root; the instance is injected. Pure value
    // constructors (createXStateFields, createXDescriptor, checksums) are data, not services, and pass.
    // Error classes are exempt. No lookaheads: esquery does not support them.
    selector:
      "ImportDeclaration:not([importKind='type'])[source.value=/^@offgrid\\/(sync|use|speech|rag|clipboard)(\\/|$)/] > ImportSpecifier:not([importKind='type'])[imported.name=/(Service|Coordinator|Engine|Registry|Resolver|Bridge|Client|Runtime|Application|Orchestrator|Transport|Session|Manager|Controller|Queue|Cache|Workflow|Authority|Channel|Timer|Adapter|Workspace|Code)$/][imported.name=/^([A-Z][a-z][A-Za-z]*|create[A-Z][A-Za-z]*)$/][imported.name!=/Error$/]",
    message:
      'Class 4: shared services are constructed in src/main/composition/** or src/renderer/src/composition/**. Import the composed instance; import the type if you only need the type.'
  },
  {
    // A deep entry of @offgrid/models bypasses the facade; only the two pure facades are allowed.
    selector:
      "ImportDeclaration:not([importKind='type'])[source.value=/^@offgrid\\/models\\//][source.value!=/^@offgrid\\/models\\/(workspace|catalog)$/] > ImportSpecifier:not([importKind='type'])[imported.name=/(Service|Coordinator|Engine|Registry|Resolver|Bridge|Client|Runtime|Application|Orchestrator|Transport|Session|Manager|Controller|Queue|Cache|Workflow|Authority|Channel|Timer|Adapter|Workspace|Code)$/][imported.name=/^([A-Z][a-z][A-Za-z]*|create[A-Z][A-Za-z]*)$/][imported.name!=/Error$/]",
    message:
      'Class 4: a deep entry of @offgrid/models bypasses the facade. Import from @offgrid/models, @offgrid/models/workspace, or @offgrid/models/catalog.'
  }
]

// Core: every selector, as an error. The queue reached zero on 2026-09-03.
const pipelineDecisions = {
  name: 'model pipeline decisions (error)',
  files: ['src/**/*.{ts,tsx}', 'pro/**/*.{ts,tsx}'],
  ignores: boundaryRootIgnores,
  plugins: { '@typescript-eslint': tsESLint.plugin },
  rules: {
    'no-restricted-syntax': ['error', ...pipelineDecisionSelectors, ...widenedPipelineDecisionSelectors]
  }
}

// File-size ratchet (2026-09-03): the mobile limits (500 lines per file, 350 per function) are errors
// here too. Files already over the limit are listed so they cannot grow the list; each removal is a
// burn-down step (see HEXAGONAL_FIX_PROGRAM_2026-09-03.md, SRP items). Add nothing to this list.
const oversizeBurnDown = [
  'pro/main/clipboard-store.ts',
  'pro/main/clipboard.ts',
  'pro/main/crm/extract.ts',
  'pro/main/crm/resolve.ts',
  'pro/main/dev-seed.ts',
  'pro/main/dictation/controller.ts',
  'pro/main/licensing/license-service.ts',
  'pro/main/meeting-native.ts',
  'pro/main/meetings.ts',
  'pro/main/services.ts',
  'pro/main/sync-ipc.ts',
  'pro/main/sync/macos-proximity.ts',
  'pro/main/sync/model-transfer-service.ts',
  'pro/main/sync/shared-file-sync-service.ts',
  'pro/main/sync/state-bridge.ts',
  'pro/main/sync/sync-service.ts',
  'pro/main/sync/sync-store.ts',
  'pro/renderer/screens/ActionsScreen.tsx',
  'pro/renderer/screens/DayView.tsx',
  'pro/renderer/screens/DevicesScreen.tsx',
  'pro/renderer/screens/EntitiesScreen.tsx',
  'pro/renderer/screens/MeetingsScreen.tsx',
  'pro/renderer/screens/NotificationList.tsx',
  'pro/renderer/screens/ReflectScreen.tsx',
  'pro/renderer/screens/ReplayScreen.tsx',
  'pro/renderer/screens/VaultScreen.tsx',
  'pro/renderer/screens/VoiceScreen.tsx',
  'pro/renderer/settings-sections.tsx',
  'src/main/accessibility/ax-agent.ts',
  'src/main/api-docs.ts',
  'src/main/browser/browser-driver.ts',
  'src/main/browser/browser-host.ts',
  'src/main/database.ts',
  'src/main/imagegen.ts',
  'src/main/index.ts',
  'src/main/ipc.ts',
  'src/main/llm.ts',
  'src/main/model-server.ts',
  'src/main/model-services.ts',
  'src/main/models-manager.ts',
  'src/main/tasks/task-history-store.ts',
  'src/main/tools.ts',
  'src/main/vision/model-adapters/ui-mate/policy.ts',
  'src/main/vision/vision-task-graph.ts',
  'src/preload/index.ts',
  'src/renderer/src/App.tsx',
  'src/renderer/src/components/ChatDetail.tsx',
  'src/renderer/src/components/connectorCatalog.ts',
  'src/renderer/src/components/ConnectorsScreen.tsx',
  'src/renderer/src/components/explore/presetCatalog.ts',
  'src/renderer/src/components/MemoryChat.tsx',
  'src/renderer/src/components/ModelsScreen.tsx',
  'src/renderer/src/components/Onboarding.tsx',
  'src/renderer/src/components/ProjectsScreen.tsx',
  'src/renderer/src/components/RemoteVisionSettingsTab.tsx',
  'src/renderer/src/components/SettingsPanel.tsx',
  'src/renderer/src/components/setup/StoragePanel.tsx',
  'src/renderer/src/components/use-chat-voice-turns.ts',
]
const fileSizeLimits = {
  name: 'file size limits (error, mobile parity)',
  files: ['src/**/*.{ts,tsx}', 'pro/**/*.{ts,tsx}'],
  ignores: ['**/*.{test,spec,dbtest}.{ts,tsx}', '**/__tests__/**', '**/*.d.ts', ...oversizeBurnDown],
  rules: {
    'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
    'max-lines-per-function': ['error', { max: 350, skipBlankLines: true, skipComments: true }]
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
  pipelineDecisions,
  fileSizeLimits,
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
