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
    'max-params': ['warn', 5],
    complexity: ['warn', 25],
    'max-lines-per-function': ['warn', 350],
    'max-lines': ['warn', 1000],
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
        varsIgnorePattern: '^_',
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
      'build/image-macos/**',
      'build/linux-bin/**',
      'build-sd-gguf/**',
      '**/coverage/**',
      '**/coverage-*/**',
      '.claude/**',
      '.offgrid/**',
      '.demo-profile/**',
      'component-library-animations/**',
      'resources/artifacts/**',
      'resources/bin/**',
      'outputs/**',
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
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'pro/renderer/**/*.{ts,tsx}'],
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
    files: ['scripts/resign.js', 'scripts/**/*.cjs'],
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
  {
    name: 'JavaScript runtime helpers',
    files: ['**/*.{js,mjs,cjs}'],
    rules: {
      // Type annotations are not valid JavaScript (including GNOME extensions).
      '@typescript-eslint/explicit-function-return-type': 'off'
    }
  },
  // These existing modules export their public hooks/helpers beside components.
  // Vite invalidates their consumers on helper changes; keep those API exports.
  {
    files: ['src/renderer/src/components/ArtifactCanvas.tsx'],
    rules: { 'react-refresh/only-export-components': ['error', { allowConstantExport: true, allowExportNames: ['artifactSpeechModelName', 'parseArtifact'] }] }
  },
  {
    files: ['src/renderer/src/components/MemoryChat/components/AssistantMessageActions.tsx'],
    rules: { 'react-refresh/only-export-components': ['error', { allowConstantExport: true, allowExportNames: ['speechControlState'] }] }
  },
  {
    files: ['src/renderer/src/components/MemoryChat/components/MessageContext.tsx'],
    rules: { 'react-refresh/only-export-components': ['error', { allowConstantExport: true, allowExportNames: ['hasInlineMemorySources', 'openUnifiedContext'] }] }
  },
  {
    files: ['src/renderer/src/components/MemoryChat/components/StylePresetPicker.tsx'],
    rules: { 'react-refresh/only-export-components': ['error', { allowConstantExport: true, allowExportNames: ['ASK_EXAMPLES', 'ASK_EXAMPLES_PRO', 'IMAGE_EXAMPLES', 'STYLE_PRESETS'] }] }
  },
  {
    files: ['src/renderer/src/components/actions/ApprovalSetup.tsx'],
    rules: { 'react-refresh/only-export-components': ['error', { allowConstantExport: true, allowExportNames: ['buildApprovalChatPrompt'] }] }
  },
  {
    files: ['src/renderer/src/components/ui/animated-modal.tsx'],
    rules: { 'react-refresh/only-export-components': ['error', { allowConstantExport: true, allowExportNames: ['useModal', 'useOutsideClick'] }] }
  },
  {
    files: ['src/renderer/src/components/ui/sidebar.tsx'],
    rules: { 'react-refresh/only-export-components': ['error', { allowConstantExport: true, allowExportNames: ['useSidebar'] }] }
  },
  {
    files: ['src/renderer/src/hooks/useReprocessing.tsx'],
    rules: { 'react-refresh/only-export-components': ['error', { allowConstantExport: true, allowExportNames: ['useReprocessing'] }] }
  },
  eslintConfigPrettier
)
