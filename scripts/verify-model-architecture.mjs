#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import { temporaryModelArchitectureAllowlist } from './model-architecture-allowlist.mjs'

const repoRoot = path.resolve(import.meta.dirname, '..')
const roots = [path.join(repoRoot, 'src')]

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__tests__' || entry.name === 'node_modules') return []
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(absolute)
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\.[jt]sx?$/.test(entry.name)
      ? [absolute]
      : []
  })
}

const files = roots.flatMap(sourceFiles)
const relative = file => path.relative(repoRoot, file).replaceAll(path.sep, '/')
const nodeText = (source, node) => node.getText(source).replace(/\s+/g, ' ')
const lineOf = (source, node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
const keyOf = finding => `${finding.rule}|${finding.file}|${finding.detail}`
const findings = []

function report(rule, file, source, node, detail) {
  findings.push({ rule, file, line: lineOf(source, node), detail })
}

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const fileName = relative(file)
  const isUi = /^src\/(renderer\/src\/(components|hooks|screens)|.*\/(components|hooks|screens))\//.test(fileName)
  const isAdapter = /(^|\/)(adapters?|model-generation-adapters|remote-chat|remote-media-runtime)(\/|\.|$)/.test(fileName)

  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      if (isUi && /(llama|litert|whisper|local[-_]?dream|imagegen\/(?:job|runtime)|image[-_]?generation[-_]?(?:service|engine)|providers?\/)/i.test(specifier)) {
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
            report('active-model-writes-use-canonical-selection-port', fileName, source, element, `import:${element.name.text}`)
          }
        }
      }
    }

    if (ts.isCallExpression(node)) {
      const call = nodeText(source, node.expression)
      const rawName = call.split('.').at(-1)
      if (/^(chat|chatMessages|chatStream|streamChat)$/.test(rawName)) {
        report('no-route-owning-llm-api', fileName, source, node, `call:${rawName}`)
      }
      if (/^(generateResponse|generateResponseWithTools|generateWithMaxTokens|generateToolSelection)$/.test(rawName)) {
        report('generation-callers-use-shared-service', fileName, source, node, `call:${rawName}`)
      }
      if (
        fileName === 'src/main/ipc.ts' &&
        /^(m\.)?setActive(Model|ModalChoice)$/.test(call)
      ) {
        report('active-model-writes-use-canonical-selection-port', fileName, source, node, `call:${call}`)
      }
    }

    if (
      (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
      node.name && /^(chat|chatMessages|chatStream|streamChat)$/.test(node.name.getText(source))
    ) {
      report('no-route-owning-llm-api', fileName, source, node.name, `declaration:${node.name.getText(source)}`)
    }

    if (isAdapter && (ts.isIfStatement(node) || ts.isSwitchStatement(node) || ts.isConditionalExpression(node))) {
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
        report('adapters-do-not-own-provider-or-reasoning-policy', fileName, source, condition, `branch:${expression}`)
      }
    }

    if (isUi && ts.isStringLiteralLike(node) && node.text.includes('remote-vision:')) {
      report('internal-remote-vision-id-never-reaches-ui', fileName, source, node, `literal:${node.text}`)
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

    if (ts.isClassDeclaration(node) && node.name && /(DownloadQueue|DownloadCoordinator|DownloadStateMachine|DownloadRegistry)$/.test(node.name.text)) {
      report('apps-do-not-own-download-state-machines', fileName, source, node.name, `class:${node.name.text}`)
    }

    if (
      (ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) &&
      /^(whisperModel|ttsModel|activeWhisperModel|activeTtsModel|whisper_model|tts_model)$/.test(
        node.name && (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) ? node.name.text : '',
      )
    ) {
      report('no-legacy-whisper-or-tts-setting-key', fileName, source, node.name, `key:${node.name.text}`)
    }

    ts.forEachChild(node, visit)
  }
  visit(source)
}

const allowlist = new Map(temporaryModelArchitectureAllowlist.map(entry => [entry.key, entry]))
const used = new Set()
const violations = []
for (const finding of findings) {
  const key = keyOf(finding)
  if (allowlist.has(key)) used.add(key)
  else violations.push(finding)
}
const stale = [...allowlist.values()].filter(entry => !used.has(entry.key))

for (const finding of findings.filter(finding => allowlist.has(keyOf(finding)))) {
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
