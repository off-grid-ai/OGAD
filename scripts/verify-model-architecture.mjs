#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import { temporaryModelArchitectureAllowlist } from './model-architecture-allowlist.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
const roots = [path.join(repoRoot, 'src'), path.join(repoRoot, 'pro')]

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '__tests__' || entry.name === 'node_modules') return []
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(absolute)
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[jt]sx?$/.test(entry.name)
      ? [absolute]
      : []
  })
}

const files = roots.flatMap(sourceFiles)
const relative = (file) => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const nodeText = (source, node) => node.getText(source).replace(/\s+/g, ' ')
const lineOf = (source, node) =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
const keyOf = (finding) => `${finding.rule}|${finding.file}|${finding.detail}`
const findings = []

function report(rule, file, source, node, detail) {
  findings.push({ rule, file, line: lineOf(source, node), detail })
}

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const fileName = relative(file)
  const isUi =
    /^src\/(renderer\/src\/(components|hooks|screens)|.*\/(components|hooks|screens))\//.test(
      fileName
    )
  const isAdapter =
    /(^|\/)(adapters?|model-generation-adapters|remote-chat|remote-media-runtime)(\/|\.|$)/.test(
      fileName
    )

  if (/\bresidencyMode\b/.test(text)) {
    report(
      'runtime-model-has-one-lifecycle-vocabulary',
      fileName,
      source,
      source,
      'deprecated:residencyMode'
    )
  }

  if (
    /^(?:src\/main\/(?:sd-server|transcription\/whisper-server))\.ts$/.test(fileName) &&
    /private idleMs\s*=\s*(?:60_000|5\s*\*\s*60_000)|return JSON\.stringify\(/.test(text)
  ) {
    report(
      'resident-engine-lifecycle-policy-is-shared',
      fileName,
      source,
      source,
      'app-owned resident identity or idle-eviction policy'
    )
  }

  if (
    fileName === 'src/main/llm.ts' &&
    /\b(?:safeTextContext|textRuntimeModeBudget)\b/.test(text)
  ) {
    report(
      'desktop-text-context-policy-is-shared',
      fileName,
      source,
      source,
      'app-owned RAM/context clamp policy'
    )
  }

  if (
    fileName === 'src/renderer/src/components/SettingsPanel.tsx' &&
    /(?:temperature:\s*0\.7|topP:\s*0\.95|topK:\s*40|repeatPenalty:\s*1\.1)/.test(text)
  ) {
    report(
      'model-configuration-defaults-are-shared',
      fileName,
      source,
      source,
      'local:text-default'
    )
  }

  if (
    /^(?:src\/main\/models\/(?:gguf|download-verify)|src\/main\/models-manager)\.ts$/.test(
      fileName
    ) &&
    /\b(?:GGUF_MAGIC|GGUF_MIN_BYTES|isValidGgufHeader|isValidGgufFile)\b|\.corruption\b|toString\(['"]ascii['"]\)\s*===?\s*['"]GGUF/.test(
      text
    )
  ) {
    report(
      'artifact-verification-policy-is-shared',
      fileName,
      source,
      source,
      'app-owned format, size, or corruption branch'
    )
  }

  if (
    /^(?:src\/main\/tools\/(?:memory-scope|extension-select)|src\/shared\/llm-defaults)\.ts$/.test(
      fileName
    )
  ) {
    report(
      'desktop-tool-policy-is-shared',
      fileName,
      source,
      source,
      `file:${path.basename(fileName)}`
    )
  }

  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      if (
        isUi &&
        /(llama|litert|whisper|local[-_]?dream|imagegen\/(?:job|runtime)|image[-_]?generation[-_]?(?:service|engine)|providers?\/)/i.test(
          specifier
        )
      ) {
        report('ui-does-not-import-raw-model-engine', fileName, source, node, `import:${specifier}`)
      }
      if (
        !/^(src\/main\/(models-manager|model-services)\.ts)$/.test(fileName) &&
        /(?:^|\/)active-models$/.test(specifier) &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const element of node.importClause.namedBindings.elements) {
          if (/^setActive/.test(element.name.text)) {
            report(
              'active-model-writes-use-canonical-selection-port',
              fileName,
              source,
              element,
              `import:${element.name.text}`
            )
          }
        }
      }
      if (/(?:^|\/)active-models$/.test(specifier)) {
        report(
          'no-active-models-compatibility-facade',
          fileName,
          source,
          node,
          `import:${specifier}`
        )
      }
      if (
        fileName === 'src/main/imagegen.ts' &&
        node.importClause?.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const element of node.importClause.namedBindings.elements) {
          if (
            /^(?:selectInstalledImageModel|enhanceImagePrompt|ImageGenerationJobCoordinator)$/.test(
              element.name.text
            )
          ) {
            report(
              'desktop-image-policy-is-shared',
              fileName,
              source,
              element,
              `import:${element.name.text}`
            )
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const call = nodeText(source, node.expression)
      const rawName = call.split('.').at(-1)
      if (call === 'llm.init' && fileName !== 'src/main/model-generation-adapters.ts') {
        report('native-text-loads-use-shared-residency', fileName, source, node, `call:${call}`)
      }
      if (/^(chat|chatMessages|chatStream|streamChat)$/.test(rawName)) {
        report('no-route-owning-llm-api', fileName, source, node, `call:${rawName}`)
      }
      if (
        /^(generateResponse|generateResponseWithTools|generateWithMaxTokens|generateToolSelection)$/.test(
          rawName
        )
      ) {
        report('generation-callers-use-shared-service', fileName, source, node, `call:${rawName}`)
      }
      if (
        fileName === 'src/main/tools.ts' &&
        /^(?:rankToolSchemas|rankToolSchemasByEmbedding|budgetToolSchemas|nativeToolPlannerUnavailableMessage|llm\.init|llm\.hasVision)$/.test(
          call
        )
      ) {
        report('desktop-tool-policy-is-shared', fileName, source, node, `call:${call}`)
      }
      if (
        isUi &&
        /^(?:window\.api\.)?(?:generateImage|toolChat|ragChat|cancelRag|cancelImageGen)$/.test(call)
      ) {
        report('desktop-ui-uses-one-chat-command-boundary', fileName, source, node, `call:${call}`)
      }
      if (/^(sendWithTools|sendImage)$/.test(rawName)) {
        report('desktop-chat-has-one-send-command', fileName, source, node, `call:${rawName}`)
      }
      if (fileName === 'src/main/ipc.ts' && /^(m\.)?setActive(Model|ModalChoice)$/.test(call)) {
        report(
          'active-model-writes-use-canonical-selection-port',
          fileName,
          source,
          node,
          `call:${call}`
        )
      }
      if (
        fileName === 'src/main/models-manager.ts' &&
        /^(?:getAllActiveModals|setActiveModal|setModal|desktopModelSelectionPersistence\.write)$/.test(
          call
        )
      ) {
        report(
          'models-manager-does-not-own-selection-persistence',
          fileName,
          source,
          node,
          `call:${call}`
        )
      }
      if (
        fileName === 'src/main/models-manager.ts' &&
        /^(?:downloadQueue\.(?:enqueue|has|isAccepting|cancel|shutdown)|downloadLedger\.(?:update|inactiveIds|remove))$/.test(
          call
        )
      ) {
        report('desktop-model-library-workflow-is-shared', fileName, source, node, `call:${call}`)
      }
      if (
        fileName !== 'src/main/model-selection-persistence.ts' &&
        fileName !== 'src/main/model-services.ts' &&
        /^desktopModelSelectionPersistence\.(?:write|projectLegacyModality)$/.test(call)
      ) {
        report(
          'selection-writes-use-canonical-model-service',
          fileName,
          source,
          node,
          `call:${call}`
        )
      }
      if (
        fileName === 'src/main/imagegen.ts' &&
        /^(?:generateDesktopOperation|generateDesktopText|registerDesktopImageProgress|evaluateImageMemory|applyImageLoras|normalizeImageLoras|resolveImageToImageDimensions)$/.test(
          call
        )
      ) {
        report('desktop-image-policy-is-shared', fileName, source, node, `call:${call}`)
      }
      if (
        fileName === 'src/main/model-generation-adapters.ts' &&
        call === 'generateImageNative' &&
        node.arguments[0] &&
        nodeText(source, node.arguments[0]) !== 'operation.executionPlan'
      ) {
        report(
          'desktop-image-adapter-executes-shared-plan',
          fileName,
          source,
          node.arguments[0],
          `argument:${nodeText(source, node.arguments[0])}`
        )
      }
    }

    if (
      ts.isNewExpression(node) &&
      /^(?:ImageGenerationJobCoordinator|ImageGenerationLifecycle)$/.test(
        nodeText(source, node.expression)
      )
    ) {
      report(
        'desktop-image-lifecycle-is-shared',
        fileName,
        source,
        node,
        `new:${nodeText(source, node.expression)}`
      )
    }

    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      /^(chat|chatMessages|chatStream|streamChat)$/.test(node.name.getText(source))
    ) {
      report(
        'no-route-owning-llm-api',
        fileName,
        source,
        node.name,
        `declaration:${node.name.getText(source)}`
      )
    }
    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      /^(sendWithTools|sendImage)$/.test(node.name.getText(source))
    ) {
      report(
        'desktop-chat-has-one-send-command',
        fileName,
        source,
        node.name,
        `declaration:${node.name.getText(source)}`
      )
    }
    if (
      fileName === 'src/main/imagegen.ts' &&
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      /^(?:maybeEnhancePrompt|resolveModel)$/.test(node.name.getText(source))
    ) {
      report(
        'desktop-image-policy-is-shared',
        fileName,
        source,
        node.name,
        `declaration:${node.name.getText(source)}`
      )
    }
    if (
      fileName === 'src/main/tools.ts' &&
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      /^(?:schemas|selectEffectiveSchemas|runToolLoop)$/.test(node.name.getText(source))
    ) {
      report(
        'desktop-tool-policy-is-shared',
        fileName,
        source,
        node.name,
        `declaration:${node.name.getText(source)}`
      )
    }
    if (
      fileName === 'src/main/models-manager.ts' &&
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name &&
      /^(?:publishRefusal|clearDeletedModelSelections|deleteTransferredModel)$/.test(
        node.name.getText(source)
      )
    ) {
      report(
        'desktop-model-library-workflow-is-shared',
        fileName,
        source,
        node.name,
        `declaration:${node.name.getText(source)}`
      )
    }

    if (
      isAdapter &&
      (ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isConditionalExpression(node))
    ) {
      const condition = ts.isIfStatement(node)
        ? node.expression
        : ts.isSwitchStatement(node)
          ? node.expression
          : node.condition
      const expression = nodeText(source, condition)
      const consumesSharedDiscoveryPlan =
        /(?:remoteCapabilityDiscoveryPlan|plan\.reasoning|plan\.nativeTools)/.test(expression)
      if (
        !consumesSharedDiscoveryPlan &&
        /(provider|reasoning|thinking|openrouter|gemini|ollama|lm.?studio)/i.test(expression)
      ) {
        report(
          'adapters-do-not-own-provider-or-reasoning-policy',
          fileName,
          source,
          condition,
          `branch:${expression}`
        )
      }
    }

    if (isUi && ts.isStringLiteralLike(node) && node.text.includes('remote-vision:')) {
      report(
        'internal-remote-vision-id-never-reaches-ui',
        fileName,
        source,
        node,
        `literal:${node.text}`
      )
    }
    if (
      /RemoteVision/.test(fileName) &&
      ts.isJsxExpression(node) &&
      node.expression &&
      nodeText(source, node.expression) === 'model.id' &&
      !ts.isJsxAttribute(node.parent)
    ) {
      report('internal-remote-vision-id-never-reaches-ui', fileName, source, node, 'jsx:model.id')
    }

    if (
      ts.isClassDeclaration(node) &&
      node.name &&
      /(DownloadQueue|DownloadCoordinator|DownloadStateMachine|DownloadRegistry)$/.test(
        node.name.text
      )
    ) {
      report(
        'apps-do-not-own-download-state-machines',
        fileName,
        source,
        node.name,
        `class:${node.name.text}`
      )
    }

    if (
      (ts.isPropertyAssignment(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node)) &&
      /^(whisperModel|ttsModel|activeWhisperModel|activeTtsModel|whisper_model|tts_model)$/.test(
        node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name))
          ? node.name.text
          : ''
      )
    ) {
      report(
        'no-legacy-whisper-or-tts-setting-key',
        fileName,
        source,
        node.name,
        `key:${node.name.text}`
      )
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
}

const allowlist = new Map(temporaryModelArchitectureAllowlist.map((entry) => [entry.key, entry]))
const used = new Set()
const violations = []
for (const finding of findings) {
  const key = keyOf(finding)
  if (allowlist.has(key)) used.add(key)
  else violations.push(finding)
}
const stale = [...allowlist.values()].filter((entry) => !used.has(entry.key))

for (const finding of findings.filter((finding) => allowlist.has(keyOf(finding)))) {
  const debt = allowlist.get(keyOf(finding))
  console.warn(`TEMPORARY ${finding.rule}: ${finding.file}:${finding.line} ${finding.detail}`)
  console.warn(`  owner=${debt.owner}; reason=${debt.reason}; removeWhen=${debt.removeWhen}`)
}
if (violations.length > 0 || stale.length > 0) {
  for (const finding of violations) {
    console.error(`VIOLATION ${finding.rule}: ${finding.file}:${finding.line} ${finding.detail}`)
  }
  for (const entry of stale) console.error(`STALE ALLOWLIST: ${entry.key}`)
  process.exitCode = 1
} else {
  console.log(`Desktop model architecture gate passed (${used.size} temporary item(s)).`)
}
