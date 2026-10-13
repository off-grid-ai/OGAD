// Demo seeder — populates an "Off Grid AI" project with chats that exercise every
// surface (text, image, markdown/HTML/React artifacts, voice/speech, skills,
// connectors). When OFFGRID_SEED=force it generates LIVE via the local models
// (LLM for artifacts, image-gen for the picture); otherwise it falls back to
// curated content so it always completes. Idempotent. On-brand, Off Grid AI only.

import { app } from 'electron'
import path from 'path'
import fs from 'fs'
import {
  createRagConversation,
  addRagMessage,
  getRagConversations,
  deleteRagConversation,
  getSetting,
  saveSetting
} from './database'
import { createProject, deleteProject, listProjects } from './rag/store'
import { saveArtifact, listArtifacts, deleteArtifact } from './artifacts'
import { saveSkill } from './skills'
import { addConnector, listConnectors } from './mcp'
import { llm } from './llm'
import { generateImage, listImageModels } from './imagegen'
import { ragService } from './rag/index'
import {
  getTaskExecutionDevice,
  getTaskRun,
  recordTaskRun,
  taskScreenshotPath
} from './tasks/task-history'
import { encodeTaskExecutionPlan, encodeTaskPhase } from '../shared/task-execution-plan'
import sharp from 'sharp'
import { getRemoteVisionServerSettings, setRemoteVisionServerSettings } from './vision/remote-vision-server'

const PROJECT_ID = 'offgrid-demo'

// Curated fallbacks (used if a live generation fails or live mode is off).
const MD = `# Off Grid AI — overview

**Run open models entirely on your device.** One local, OpenAI-compatible gateway
serves text, vision, image, voice, and speech — no cloud, no accounts, no API keys.

## Why Off Grid AI
- **Private by default** — nothing leaves your machine.
- **Every modality, one endpoint** — \`http://127.0.0.1:7878/v1\`.
- **Bring any GGUF** — download from the catalog or Hugging Face.
`

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:ui-monospace,Menlo,monospace;background:#0a0a0a;color:#fff;
       display:flex;align-items:center;justify-content:center;height:100vh}
  h1{font-size:44px;background:linear-gradient(90deg,#fff,#34D399);-webkit-background-clip:text;-webkit-text-fill-color:transparent}
  p{color:#a3a3a3}a{background:#059669;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none}
</style></head><body><div style="text-align:center">
  <h1>Off Grid AI</h1><p>Private, on-device AI. No cloud, no accounts.</p><a href="#">Download for macOS</a>
</div></body></html>`

const REACT = `export default function Hero() {
  return (
    <div style={{ fontFamily: 'Menlo, monospace', background: '#0a0a0a', color: '#fff', padding: 48, textAlign: 'center' }}>
      <h1 style={{ color: '#34D399' }}>Off Grid AI</h1>
      <p style={{ color: '#a3a3a3' }}>Run open models locally — text, vision, image, voice.</p>
    </div>
  );
}`

function extractCode(text: string): string | null {
  const m = /```[a-zA-Z]*\n([\s\S]*?)```/.exec(text)
  return m ? m[1]!.trim() : null
}

async function gen(prompt: string): Promise<string | null> {
  try {
    const out = await llm.chat(prompt, [], 120_000, 1500, { disableThinking: true })
    return out.trim() || null
  } catch (e) {
    console.error('[seed] llm.chat failed', e)
    return null
  }
}

function chatTurn(
  slug: string,
  title: string,
  user: string,
  assistant: string,
  ctx?: unknown
): string {
  const id = createRagConversation(`demo-${slug}`, title, PROJECT_ID)
  addRagMessage(id, 'user', user)
  addRagMessage(id, 'assistant', assistant, ctx)
  return id
}

// A minimal, valid one-page PDF with extractable text (no deps).
function tinyPdf(line: string): Buffer {
  const text = `BT /F1 16 Tf 72 720 Td (${line.replace(/[()\\]/g, '')}) Tj ET`
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    '<</Type/Pages/Kids[3 0 R]/Count 1>>',
    '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
    `<</Length ${text.length}>>\nstream\n${text}\nendstream`,
    '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(body.length)
    body += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = body.length
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  offsets.forEach((off) => {
    body += `${String(off).padStart(10, '0')} 00000 n \n`
  })
  body += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(body, 'latin1')
}

// Seed a few knowledge-base files (md + txt + pdf) and index them into the project.
async function seedKnowledge(): Promise<void> {
  const dir = path.join(app.getPath('userData'), 'demo-docs')
  fs.mkdirSync(dir, { recursive: true })
  const files: { name: string; write: () => void }[] = [
    {
      name: 'offgrid-overview.md',
      write: () => fs.writeFileSync(path.join(dir, 'offgrid-overview.md'), MD)
    },
    {
      name: 'offgrid-faq.txt',
      write: () =>
        fs.writeFileSync(
          path.join(dir, 'offgrid-faq.txt'),
          'Off Grid AI — FAQ\n\nQ: Does anything leave my device?\nA: No. All inference runs locally; no cloud, no accounts, no API keys.\n\nQ: What can it run?\nA: Open models for text, vision, image, voice and speech, via one OpenAI-compatible gateway on 127.0.0.1:7878.\n\nQ: What is Pro?\nA: The sees/remembers/acts layer — capture, unified search, a proactive secretary — live now, $119 once or $7.99/month.\n'
        )
    },
    {
      name: 'offgrid-onepager.pdf',
      write: () =>
        fs.writeFileSync(
          path.join(dir, 'offgrid-onepager.pdf'),
          tinyPdf('Off Grid AI - private, on-device AI. Run open models locally. No cloud.')
        )
    }
  ]
  for (const f of files) {
    try {
      f.write()
      const p = path.join(dir, f.name)
      await ragService.indexDocument(
        { projectId: PROJECT_ID, path: p, fileName: f.name, size: fs.statSync(p).size },
        () => {}
      )
      console.log('[seed] indexed', f.name)
    } catch (e) {
      console.error('[seed] index failed', f.name, e)
    }
  }
}

function cleanup(): void {
  for (const c of getRagConversations(PROJECT_ID)) deleteRagConversation(c.id)
  for (const a of listArtifacts({ projectId: PROJECT_ID })) deleteArtifact(a.id)
  try {
    deleteProject(PROJECT_ID)
  } catch {
    /* fresh */
  }
}

export async function seedDemo(live = false): Promise<void> {
  if (getRemoteVisionServerSettings().servers.length === 0) {
    setRemoteVisionServerSettings({
      serverId: 'demo-acme-private-models',
      name: 'Acme private models',
      provider: 'custom',
      endpoint: 'https://models.acme.example/v1',
      model: 'Qwen 3.5 9B',
      mediaModels: { text: 'Qwen 3.5 9B', image: 'Qwen Image 3', voice: 'Kokoro' },
      modelCatalog: [
        { id: 'Qwen 3.5 9B', name: 'Qwen 3.5 9B', kind: 'text' },
        { id: 'Qwen Image 3', name: 'Qwen Image 3', kind: 'image' },
        { id: 'Kokoro', name: 'Kokoro', kind: 'voice' }
      ]
    })
  }
  // Marketing scenes use the normal data owners, so files, chats and task history also travel by Sync.
  const acmeProjectId = 'demo-acme-pilot'
  if (!listProjects().some((project) => project.id === acmeProjectId)) {
    createProject({
      id: acmeProjectId,
      name: 'Acme Corp pilot',
      description: 'Synthetic customer pilot for Alex at Off Grid AI.'
    })
  }
  const acmeChats = [
    [
      'promises',
      'What did I promise Sam?',
      'What did I promise Sam?',
      'You made three commitments to Sam:\n\n1. Send the pilot scope for 40 seats, starting on 14 November.\n2. Confirm the owners and checks: Priya owns the rollout, and Tom verifies the gateway policy.\n3. Arrange a kickoff call next Tuesday.'
    ],
    [
      'owners',
      'Acme pilot owners and kickoff',
      'Who owns the rollout and when does the pilot start?',
      'Priya Nair owns the rollout plan. Tom Reyes verifies the gateway policy before kickoff. The pilot starts on 14 November with 40 seats. Source: Acme_rollout_v3.pdf.'
    ],
    [
      'translation',
      'Translate the pilot email',
      'Translate my pilot update into Spanish. Keep the names unchanged.',
      'Hola Sam:\n\nEl piloto de Acme Corp comienza el 14 de noviembre con 40 plazas. Priya Nair se encarga del plan de despliegue y Tom Reyes verifica la política de la pasarela antes de la reunión inicial. Te enviaré el plan el viernes a las 10:00. Confirmemos la reunión inicial para el próximo martes.\n\nAlex'
    ],
    [
      'reply',
      'Reply to Sam',
      'Draft a short reply to Sam confirming the pilot scope and next steps.',
      'Hi Sam,\n\nThe Acme Corp pilot starts on 14 November with 40 seats. Priya owns the rollout plan, and Tom will verify the gateway policy before kickoff. I will send the rollout plan on Friday at 10 AM. Let us confirm the kickoff call for next Tuesday.\n\nAlex'
    ]
  ] as const
  const conversations = getRagConversations()
  for (const [slug, title, prompt, answer] of acmeChats) {
    const id = `demo-acme-${slug}`
    if (conversations.some((chat) => chat.id === id)) continue
    createRagConversation(id, title, acmeProjectId)
    addRagMessage(id, 'user', prompt)
    addRagMessage(id, 'assistant', answer)
  }
  const rolloutPdf = path.join(app.getAppPath(), 'resources', 'demo', 'Acme_rollout_v3.pdf')
  if (fs.existsSync(rolloutPdf)) {
    const documents = await ragService.listDocuments(acmeProjectId)
    if (!documents.some((document) => document.name === 'Acme_rollout_v3.pdf')) {
      await ragService.indexDocument({
        projectId: acmeProjectId,
        path: rolloutPdf,
        fileName: 'Acme_rollout_v3.pdf',
        size: fs.statSync(rolloutPdf).size
      })
    }
  }
  const taskId = 'demo-acme-reminder'
  const frame = path.join(app.getAppPath(), 'resources', 'demo', 'acme-reminder.png')
  if (!getTaskRun(taskId) && fs.existsSync(frame)) {
    const conversationId = 'demo-acme-computer-use'
    if (!getRagConversations().some((chat) => chat.id === conversationId)) {
      createRagConversation(conversationId, 'Send Sam the rollout plan', acmeProjectId, 'god')
      addRagMessage(
        conversationId,
        'user',
        'Create reminder: Send Sam the rollout plan, Friday 10 AM'
      )
    }
    const device = getTaskExecutionDevice()
    const screenshotPath = taskScreenshotPath(taskId, '4')
    fs.copyFileSync(frame, screenshotPath)
    const metadata = await sharp(frame).metadata()
    const width = metadata.width
    const height = metadata.height
    const phases = [
      'Open Reminders',
      'Create the rollout reminder',
      'Set Friday at 10 AM',
      'Check the reminder'
    ].map((title, index) => ({ id: String(index + 1), title }))
    const at = Date.now()
    // A completed synthetic history item. It must not claim that a live controller is running.
    recordTaskRun({
      taskId,
      journeyId: conversationId,
      kind: 'computer_use',
      status: 'done',
      title: 'Create reminder: Send Sam the rollout plan, Friday 10 AM',
      summary: 'Created the reminder for Friday at 10 AM.',
      executionDeviceId: device.id,
      executionDeviceName: device.name,
      phase: 'complete',
      currentStep: 4,
      screenshotPath,
      screenshotDeviceId: device.id,
      at,
      steps: [
        encodeTaskExecutionPlan({ version: 1, phases }),
        ...phases.flatMap((phase) => [encodeTaskPhase(phase.id), phase.title])
      ],
      stepDetails: phases.map((phase, index) => ({
        stepId: phase.id,
        at: at - (3 - index) * 1000,
        phase: 'complete',
        decisionSummary: phase.title,
        execution: { status: 'complete', result: phase.title },
        ...(index === 3
          ? {
              screenshot: {
                path: screenshotPath,
                availability: 'device_local',
                executionDeviceId: device.id,
                executionDeviceName: device.name,
                originalWidth: width,
                originalHeight: height,
                inferenceWidth: width,
                inferenceHeight: height
              }
            }
          : {})
      }))
    })
  }

  if (!live && getSetting<boolean>('demo:seeded', false)) {
    console.log('[seed] already seeded — skipping')
    return
  }
  try {
    cleanup()
    createProject({
      id: PROJECT_ID,
      name: 'Off Grid AI',
      description: 'Demo workspace showcasing Off Grid AI.',
      icon: '🟢'
    })
    if (live) {
      try {
        await llm.init()
      } catch (e) {
        console.error('[seed] llm init', e)
      }
    }

    // Knowledge base: index a few docs (md + txt + pdf) into the project.
    await seedKnowledge()

    // Helper: generate an artifact live (or fall back), store the chat + artifact.
    const artifactChat = async (
      slug: string,
      title: string,
      user: string,
      prompt: string,
      kind: 'text' | 'html' | 'react',
      lang: string,
      fallback: string
    ): Promise<void> => {
      let code = fallback
      if (live) {
        const out = await gen(prompt)
        const c = out && extractCode(out)
        if (c) code = c
      }
      const id = chatTurn(slug, title, user, `Here you go:\n\n\`\`\`${lang}\n${code}\n\`\`\``)
      saveArtifact({ kind, code, title, conversationId: id, projectId: PROJECT_ID })
    }

    await artifactChat(
      'overview',
      'Off Grid AI overview',
      'Write a short overview doc for Off Grid AI.',
      'Write a concise Markdown overview of "Off Grid AI" — a private, on-device AI that runs open models (text, vision, image, voice) via one local OpenAI-compatible gateway, no cloud. Return ONLY a ```markdown code block.',
      'text',
      'markdown',
      MD
    )

    await artifactChat(
      'landing',
      'Landing hero (HTML)',
      'Build a landing hero for Off Grid AI.',
      'Create a single self-contained HTML document for an "Off Grid AI" landing hero: dark background, emerald accent (#34D399), a headline, one line of copy, and a "Download for macOS" button. Return ONLY a ```html code block.',
      'html',
      'html',
      HTML
    )

    await artifactChat(
      'pricing',
      'Hero (React)',
      'Make a React hero component for Off Grid AI.',
      'Write a single default-export React component (no imports) for an "Off Grid AI" hero with inline styles, dark background, emerald accent. Return ONLY a ```jsx code block.',
      'react',
      'jsx',
      REACT
    )

    // Voice + speech (speakable reply; record to test STT).
    chatTurn(
      'voice',
      'Voice & speech',
      'Say one line about Off Grid AI I can listen to.',
      'Off Grid AI is private, on-device AI — your models and your data never leave your machine. Tap the speaker to hear this, or hold the mic to talk back.'
    )

    // Skills — a manual /skill pack + a chat using it.
    saveSkill({
      name: 'offgrid-pitch',
      description: 'Rewrite text as a crisp Off Grid AI one-liner.',
      instructions:
        'Rewrite the input as a single confident sentence in the Off Grid AI voice: private, on-device, no cloud. No hype, no emojis.'
    })
    {
      const u = 'we run AI models on your computer without the internet'
      let a =
        'Off Grid AI runs open models entirely on your device — no cloud, no accounts, nothing ever leaves your machine.'
      if (live) {
        const out = await gen(
          `Rewrite as one confident Off Grid AI sentence (private, on-device, no cloud; no hype, no emojis): "${u}"`
        )
        if (out) a = out.replace(/^["']|["']$/g, '')
      }
      chatTurn('skills', 'Skills', `/offgrid-pitch ${u}`, a)
    }

    // Connectors — add a demo MCP server (no-auth) so Integrations has an entry.
    if (!listConnectors().some((c) => c.name === 'Demo MCP (Everything)')) {
      addConnector({
        name: 'Demo MCP (Everything)',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything']
      })
    }
    chatTurn(
      'connectors',
      'Connectors',
      'What tools does my connected MCP server expose?',
      'Your "Demo MCP" exposes example tools (echo, add, longRunningOperation, …). Turn Connectors on in the composer to call them right from chat — reads run inline.'
    )

    // 7) Images LAST (image-gen pauses the LLM). Generate one per installed image
    //    model so every model is exercised in its own chat. Skip CoreML dirs +
    //    the bare VAE (ae.safetensors). Falls back to the logo if none/failed.
    const prompt =
      'a serene off-grid cabin on a forested mountain at dawn, misty valley, warm light, highly detailed, no text'
    const imgDir = path.join(app.getPath('userData'), 'generated-images')
    fs.mkdirSync(imgDir, { recursive: true })
    const pretty = (m: string): string =>
      m
        .replace(/\.(gguf|safetensors)$/i, '')
        .replace(/-Q\d.*$/i, '')
        .replace(/[-_]/g, ' ')
        .trim()
    const slugify = (m: string): string =>
      m
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .slice(0, 28)
    const models = live
      ? listImageModels().filter((m) => /\.(gguf|safetensors)$/i.test(m) && !/^ae\./i.test(m))
      : []
    let madeAny = false
    for (const model of models) {
      try {
        const out = await generateImage({ prompt, model, width: 768, height: 512, steps: 18 })
        const id = chatTurn(
          `image-${slugify(model)}`,
          `Image · ${pretty(model)}`,
          `Generate an Off Grid AI scene with ${pretty(model)}.`,
          `Generated for: ${prompt}\n\nModel: ${model}`,
          { image: out.path }
        )
        try {
          fs.writeFileSync(
            `${out.path}.json`,
            JSON.stringify({ conversationId: id, projectId: PROJECT_ID })
          )
        } catch {
          /* best effort */
        }
        madeAny = true
        console.log('[seed] image via', model, '->', path.basename(out.path))
      } catch (e) {
        console.error('[seed] image model failed', model, e)
      }
    }
    if (!madeAny) {
      // Fallback: at least one image chat so the surface is testable.
      const src = [
        path.join(app.getAppPath(), 'resources', 'icon.png'),
        path.join(process.resourcesPath || '', 'icon.png')
      ].find((p) => fs.existsSync(p))
      if (src) {
        const dest = path.join(imgDir, 'offgrid-demo-mark.png')
        try {
          fs.copyFileSync(src, dest)
          const id = chatTurn(
            'image',
            'Brand mark (image)',
            'Generate the Off Grid AI brand mark.',
            'Generated for: Off Grid AI brand mark',
            { image: dest }
          )
          fs.writeFileSync(
            `${dest}.json`,
            JSON.stringify({ conversationId: id, projectId: PROJECT_ID })
          )
        } catch (e) {
          console.error('[seed] image fallback', e)
        }
      }
    }

    saveSetting('demo:seeded', true)
    console.log(`[seed] demo project seeded ✓ (live=${live})`)
  } catch (e) {
    console.error('[seed] failed', e)
  }
}
