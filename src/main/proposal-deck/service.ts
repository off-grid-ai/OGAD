import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import {
  advanceProposal,
  proposalNextInstruction,
  type ProposalCaseStudy,
  type ProposalGeography,
  type ProposalIllustration,
  type ProposalSaleMode,
  type ProposalSession,
  type ProposalTransition
} from './state'

const PRD_PATH = '/Users/user/wednesday/cro/PRD - Proposal Deck Generator.md'

const STAGE_FILE: Partial<Record<ProposalTransition['kind'], string>> = {
  save_website_context: 'website_context.md',
  save_narrative_plan: 'narrative_plan.md',
  revise_narrative_plan: 'narrative_plan.md',
  save_skeleton: 'skeleton.md',
  revise_skeleton: 'skeleton.md',
  save_case_studies: 'case_studies.md',
  save_full_copy: 'full_copy.md',
  revise_full_copy: 'full_copy.md'
}

export interface StartProposalInput {
  conversationId: string
  company: string
  brief: string
  saleMode: ProposalSaleMode
  geography: ProposalGeography
  website?: string
  sourceFolder: string
  outputFolder: string
  styleFolder?: string
}

export interface ProposalServiceOptions {
  sessionsRoot?: string
  outputRoot?: string
}

function safeCompanyName(company: string): string {
  const value = company
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
  if (!value || value === '.' || value === '..') throw new Error('Enter the client company name.')
  return value.slice(0, 100)
}

function atomicWrite(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${String(process.pid)}.tmp`
  try {
    fs.writeFileSync(temporary, content, 'utf8')
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function chooseOutputDir(root: string, company: string): string {
  const base = path.join(root, safeCompanyName(company))
  if (!fs.existsSync(base)) return base
  const date = new Date().toISOString().slice(0, 10)
  let candidate = `${base} ${date}`
  let suffix = 2
  while (fs.existsSync(candidate)) candidate = `${base} ${date} ${String(suffix++)}`
  return candidate
}

function readSource(file: string, maxChars: number): string {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return ''
    return fs.readFileSync(file, 'utf8').slice(0, maxChars)
  } catch {
    return ''
  }
}

function checkedDirectory(input: string, label: string): string {
  const resolved = path.resolve(input.trim())
  if (!input.trim() || !fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${label} must be a local folder you can access.`)
  }
  return resolved
}

const READABLE_SOURCE = /\.(md|markdown|txt|csv|json|html|css)$/i
const DOCUMENT_SOURCE = /\.(pdf|docx|pptx)$/i

function decodeXmlText(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
}

async function extractPresentation(file: string, maxChars: number): Promise<string> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(await fs.promises.readFile(file))
  const slides = Object.values(zip.files)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true }))
  const text: string[] = []
  for (const slide of slides) {
    const xml = await slide.async('string')
    const fragments = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) =>
      decodeXmlText(match[1] ?? '')
    )
    if (fragments.length) text.push(`${slide.name}: ${fragments.join(' ')}`)
    if (text.join('\n').length >= maxChars) break
  }
  return text.join('\n').slice(0, maxChars)
}

async function readDocumentSource(file: string, maxChars: number): Promise<string> {
  try {
    if (/\.pptx$/i.test(file)) return await extractPresentation(file, maxChars)
    const { desktopExtraction } = await import('../rag/extractors')
    if (/\.pdf$/i.test(file) && desktopExtraction.extractPdf) {
      return await desktopExtraction.extractPdf(file, maxChars)
    }
    if (/\.docx$/i.test(file) && desktopExtraction.extractDocx) {
      return await desktopExtraction.extractDocx(file, maxChars)
    }
  } catch {
    return ''
  }
  return ''
}

function contextLimitReached(inventoryCount: number, used: number, maxChars: number): boolean {
  return inventoryCount >= 160 || used >= maxChars
}

function skipContextEntry(entry: fs.Dirent): boolean {
  return entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()
}

function readableContextFile(name: string): boolean {
  return READABLE_SOURCE.test(name) || DOCUMENT_SOURCE.test(name)
}

async function readContextFile(file: string, name: string, maxChars: number): Promise<string> {
  return READABLE_SOURCE.test(name)
    ? readSource(file, maxChars)
    : await readDocumentSource(file, maxChars)
}

async function collectFolderContext(root: string, maxChars = 60_000): Promise<string> {
  const inventory: string[] = []
  const content: string[] = []
  const folders = [root]
  let used = 0
  while (folders.length && !contextLimitReached(inventory.length, used, maxChars)) {
    const folder = folders.shift()
    if (!folder) break
    const entries = fs
      .readdirSync(folder, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (skipContextEntry(entry)) continue
      const target = path.join(folder, entry.name)
      const relative = path.relative(root, target)
      inventory.push(`${entry.isDirectory() ? 'folder' : 'file'}: ${relative}`)
      if (entry.isDirectory()) folders.push(target)
      else if (readableContextFile(entry.name) && used < maxChars) {
        const fileLimit = Math.min(12_000, maxChars - used)
        const text = await readContextFile(target, entry.name, fileLimit)
        if (text) {
          content.push(`## ${relative}\n${text}`)
          used += text.length
        }
      }
      if (contextLimitReached(inventory.length, used, maxChars)) break
    }
  }
  return `Folder: ${root}\n\n# Inventory\n${inventory.join('\n')}\n\n# Readable content\n${content.join('\n\n')}`
}

export class ProposalDeckService {
  private readonly sessionsRoot: string
  private readonly outputRoot: string

  constructor(options: ProposalServiceOptions = {}) {
    this.sessionsRoot = options.sessionsRoot ?? path.join(app.getPath('userData'), 'proposal-decks')
    this.outputRoot = options.outputRoot ?? ''
  }

  private sessionFile(conversationId: string): string {
    const safeId = conversationId.replace(/[^A-Za-z0-9_-]/g, '')
    if (!safeId) throw new Error('A proposal must run inside a saved chat.')
    return path.join(this.sessionsRoot, `${safeId}.json`)
  }

  get(conversationId: string): ProposalSession | null {
    try {
      return JSON.parse(
        fs.readFileSync(this.sessionFile(conversationId), 'utf8')
      ) as ProposalSession
    } catch {
      return null
    }
  }

  start(input: StartProposalInput): ProposalSession {
    const existing = this.get(input.conversationId)
    if (existing) return existing
    if (!input.brief.trim()) throw new Error('Add the meeting context and what must land.')
    const now = new Date().toISOString()
    const sourceFolder = checkedDirectory(input.sourceFolder, 'Content source')
    const outputRoot = checkedDirectory(input.outputFolder || this.outputRoot, 'Output location')
    const styleFolder = input.styleFolder?.trim()
      ? checkedDirectory(input.styleFolder, 'Style reference')
      : undefined
    const outputDir = chooseOutputDir(outputRoot, input.company)
    fs.mkdirSync(outputDir, { recursive: true })
    const session: ProposalSession = {
      version: 2,
      conversationId: input.conversationId,
      company: safeCompanyName(input.company),
      brief: input.brief.trim(),
      saleMode: input.saleMode,
      geography: input.geography,
      ...(input.website?.trim() ? { website: input.website.trim() } : {}),
      sourceFolder,
      ...(styleFolder ? { styleFolder } : {}),
      outputRoot,
      outputDir,
      stage: input.website?.trim() ? 'website_research' : 'narrative_plan',
      caseStudies: [],
      selectedCaseStudies: [],
      illustrations: [],
      createdAt: now,
      updatedAt: now
    }
    atomicWrite(this.sessionFile(input.conversationId), JSON.stringify(session, null, 2))
    atomicWrite(
      path.join(outputDir, 'brief.md'),
      `# ${session.company}\n\n## Sale mode\n${session.saleMode}\n\n## Audience\n${session.geography}\n\n## Content source\n${session.sourceFolder}\n\n## Style reference\n${session.styleFolder ?? 'Use the Off Grid AI deck standard.'}\n${session.website ? `\n## Website\n${session.website}\n` : ''}\n## Brief\n${session.brief}\n`
    )
    return session
  }

  transition(
    conversationId: string,
    transition: ProposalTransition,
    content?: string
  ): ProposalSession {
    const current = this.get(conversationId)
    if (!current) throw new Error('Start the proposal before saving a stage.')
    const next = advanceProposal(current, transition)
    const stageFile = STAGE_FILE[transition.kind]
    if (stageFile) {
      if (!content?.trim()) throw new Error('This stage cannot be empty.')
      atomicWrite(path.join(current.outputDir, stageFile), `${content.trim()}\n`)
    }
    atomicWrite(this.sessionFile(conversationId), JSON.stringify(next, null, 2))
    return next
  }

  async context(session: ProposalSession): Promise<string> {
    const websiteContext = readSource(path.join(session.outputDir, 'website_context.md'), 30_000)
    const prd = readSource(PRD_PATH, 28_000)
    const sourceContext = await collectFolderContext(session.sourceFolder)
    const styleContext = session.styleFolder
      ? await collectFolderContext(session.styleFolder, 20_000)
      : ''
    return [
      `# Active proposal\nCompany: ${session.company}\nSale mode: ${session.saleMode}\nAudience: ${session.geography}\nStage: ${session.stage}\nBrief: ${session.brief}`,
      `# User-approved content source\n${sourceContext}`,
      styleContext ? `# User-approved style reference\n${styleContext}` : '',
      websiteContext
        ? `# Public company context\n${websiteContext}`
        : session.website
          ? '# Public company context\nNo website content was available. Do not infer facts from the URL.'
          : '',
      `# Proposal rules\n${prd}`,
      `# Next action\n${proposalNextInstruction(session.stage)}`
    ].join('\n\n')
  }

  saveIllustration(conversationId: string, slide: number, generatedImagePath: string): string {
    const session = this.get(conversationId)
    if (!session) throw new Error('Proposal session not found.')
    const expected = session.illustrations.some((illustration) => illustration.slide === slide)
    if (!expected) throw new Error('This slide did not request an illustration.')
    const source = path.resolve(generatedImagePath)
    const generatedRoot = path.resolve(app.getPath('userData'), 'generated-images')
    if (source !== generatedRoot && !source.startsWith(generatedRoot + path.sep)) {
      throw new Error('The image is outside the Off Grid AI image library.')
    }
    const destination = path.join(session.outputDir, `slide_${String(slide)}_illustration.png`)
    fs.copyFileSync(source, destination)
    return destination
  }

  summary(session: ProposalSession): string {
    return [
      `Proposal: ${session.company}`,
      `Stage: ${session.stage}`,
      `Output: ${session.outputDir}`,
      proposalNextInstruction(session.stage)
    ].join('\n')
  }

  computerBuildGoal(session: ProposalSession): string {
    const deckName = `${safeCompanyName(session.company)} proposal`
    return [
      `Create the completed ${deckName} presentation in Keynote or PowerPoint.`,
      `Use ${path.join(session.outputDir, 'full_copy.md')} as the approved slide copy.`,
      `Use illustrations from ${session.outputDir}.`,
      session.styleFolder
        ? `Use ${session.styleFolder} only as a visual style reference.`
        : 'Use the Off Grid AI presentation style.',
      `Save an editable .pptx and a .pdf inside ${session.outputDir}.`,
      'Do not change approved copy. Confirm both files exist before finishing.'
    ].join(' ')
  }
}

let service: ProposalDeckService | null = null
export function proposalDeckService(): ProposalDeckService {
  service ??= new ProposalDeckService()
  return service
}

export function proposalDeckSystemHint(conversationId?: string): string {
  if (!conversationId) return ''
  const session = proposalDeckService().get(conversationId)
  if (!session) return ''
  return `This chat owns an active proposal workflow. Always use proposal_deck before answering. ${proposalNextInstruction(session.stage)}`
}

export type { ProposalCaseStudy, ProposalIllustration }
