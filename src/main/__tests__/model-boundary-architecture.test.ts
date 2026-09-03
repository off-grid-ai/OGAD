import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function productionTypeScript(root: string): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (/\.tsx?$/.test(entry.name)) files.push(absolute)
    }
  }
  visit(root)
  return files
}

function offenders(
  files: readonly string[],
  pattern: RegExp,
  allowed: ReadonlySet<string>
): string[] {
  return files.flatMap((file) => {
    const relative = path.relative(desktopRoot, file).replaceAll(path.sep, '/')
    if (allowed.has(relative)) return []
    pattern.lastIndex = 0
    return pattern.test(fs.readFileSync(file, 'utf8')) ? [relative] : []
  })
}

const desktopProduction = productionTypeScript(path.join(desktopRoot, 'src/main'))
const proProduction = productionTypeScript(path.join(desktopRoot, 'pro/main'))
const allProduction = [...desktopProduction, ...proProduction]

describe('model execution architecture', () => {
  it('keeps legacy LLM execution inside the shared GenerationService adapter', () => {
    expect(
      offenders(allProduction, /\bllm\.(?:chat|chatStream|streamChat)\s*\(/g, new Set([
        'src/main/model-generation-adapters.ts'
      ]))
    ).toEqual([])
  })

  it('keeps raw modality engines behind the Desktop generation adapter', () => {
    expect(
      offenders(
        allProduction,
        /\b(?:generateImageNative|synthesizeNative|getNativeTranscriptionForRoute|generateEmbeddingNative)\s*\(/g,
        new Set([
          'src/main/embeddings.ts',
          'src/main/imagegen.ts',
          'src/main/model-generation-adapters.ts',
          'src/main/transcription/select.ts',
          'src/main/tts.ts'
        ])
      )
    ).toEqual([])
  })

  it('allows direct GenerationService calls only at thin protocol composition boundaries', () => {
    expect(
      offenders(
        allProduction,
        /desktopModelServices\.generation\.generate\s*\(/g,
        new Set([
          'pro/main/generation.ts',
          'src/main/browser/browser-playwright-policy.ts',
          'src/main/desktop-generation.ts',
          'src/main/ipc.ts',
          'src/main/mcp-server.ts',
          // The HTTP gateway is a protocol boundary like the MCP server: it maps wire requests onto
          // the shared generation service and nothing else.
          'src/main/model-server.ts'
        ])
      )
    ).toEqual([])
  })

  it('keeps Pro away from raw provider and native model adapters', () => {
    expect(
      offenders(
        proProduction,
        /from\s+['"]@offgrid\/core\/main\/(?:model-generation-adapters|llm\/(?:remote-chat|stream)|transcription\/(?:parakeet-cli|whisper-server-transcription))['"]/g,
        new Set()
      )
    ).toEqual([])
  })
})
