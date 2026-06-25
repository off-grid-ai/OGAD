// Demo seeder — populates an "Off Grid AI" project with chats that exercise every
// surface (text, image, markdown/HTML/React artifacts, voice/speech, skills,
// connectors) so the whole app can be tested end-to-end. Professional, on-brand,
// Off Grid only. Idempotent. Run with OFFGRID_SEED=1 (or IPC dev:seed).

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { createRagConversation, addRagMessage, getSetting, saveSetting } from './database';
import { createProject, listProjects } from './rag/store';
import { saveArtifact } from './artifacts';
import { saveSkill } from './skills';
import { addConnector, listConnectors } from './mcp';

const PROJECT_ID = 'offgrid-demo';

const MD = `# Off Grid AI — overview

**Run open models entirely on your device.** One local, OpenAI-compatible gateway
serves text, vision, image, voice, and speech — no cloud, no accounts, no API keys.

## Why Off Grid
- **Private by default** — nothing leaves your machine.
- **Every modality, one endpoint** — \`http://127.0.0.1:7878/v1\`.
- **Bring any GGUF** — download from the catalog or Hugging Face.

## Free vs Pro
| | Free | Pro (July 2026) |
|---|---|---|
| Local model runner | ✅ | ✅ |
| Chat · Projects · Image · Voice | ✅ | ✅ |
| MCP connectors | ✅ | ✅ |
| Sees / remembers / acts | — | ✅ |
`;

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;font-family:ui-monospace,Menlo,monospace;background:#0a0a0a;color:#fff;
       display:flex;align-items:center;justify-content:center;height:100vh}
  .card{text-align:center;padding:48px}
  h1{font-size:44px;margin:0 0 12px;background:linear-gradient(90deg,#fff,#34D399);
     -webkit-background-clip:text;-webkit-text-fill-color:transparent}
  p{color:#a3a3a3;max-width:480px;margin:0 auto 24px}
  a{display:inline-block;background:#059669;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none}
</style></head><body>
  <div class="card">
    <h1>Off Grid AI</h1>
    <p>Private, on-device AI. Your models, your data — no cloud, no accounts.</p>
    <a href="#">Download for macOS</a>
  </div>
</body></html>`;

const REACT = `export default function Pricing() {
  const tiers = [
    { name: 'Free', price: '$0', items: ['Local model runner', 'Chat · Projects · Image · Voice', 'MCP connectors'] },
    { name: 'Pro', price: 'July 2026', items: ['Everything in Free', 'Always-on memory + unified search', 'Proactive secretary'] },
  ];
  return (
    <div style={{ display: 'flex', gap: 16, padding: 24, fontFamily: 'Menlo, monospace', background: '#0a0a0a' }}>
      {tiers.map((t) => (
        <div key={t.name} style={{ flex: 1, border: '1px solid #262626', borderRadius: 14, padding: 24, color: '#fff' }}>
          <div style={{ color: '#34D399', fontWeight: 600 }}>{t.name}</div>
          <div style={{ fontSize: 28, margin: '8px 0 16px' }}>{t.price}</div>
          {t.items.map((i) => <div key={i} style={{ color: '#a3a3a3', fontSize: 13, margin: '6px 0' }}>✓ {i}</div>)}
        </div>
      ))}
    </div>
  );
}`;

/** A user→assistant turn in one conversation. */
function chat(title: string, user: string, assistant: string, ctx?: unknown): string {
  const id = createRagConversation(`demo-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)}`, title, PROJECT_ID);
  addRagMessage(id, 'user', user);
  addRagMessage(id, 'assistant', assistant, ctx);
  return id;
}

export function seedDemo(force = false): void {
  if (!force && getSetting<boolean>('demo:seeded', false)) {
    console.log('[seed] already seeded — skipping');
    return;
  }
  try {
    if (!listProjects().some((p) => p.id === PROJECT_ID)) {
      createProject({ id: PROJECT_ID, name: 'Off Grid AI', description: 'Demo workspace showcasing Off Grid AI.', icon: '🟢' });
    }

    // 1) Text overview + a Markdown artifact.
    chat('Off Grid overview', 'What is Off Grid AI? Give me a short overview doc.',
      `Off Grid AI runs open models entirely on your device. Here's an overview:\n\n\`\`\`markdown\n${MD}\n\`\`\``);
    saveArtifact({ kind: 'text', code: MD, title: 'Off Grid AI — overview', projectId: PROJECT_ID });

    // 2) HTML artifact — a landing hero.
    chat('Landing hero (HTML)', 'Build a simple landing hero for Off Grid AI.',
      `Here's a self-contained landing hero:\n\n\`\`\`html\n${HTML}\n\`\`\``);
    saveArtifact({ kind: 'html', code: HTML, title: 'Off Grid AI — landing hero', projectId: PROJECT_ID });

    // 3) React artifact — a pricing component.
    chat('Pricing card (React)', 'Make a React pricing component (Free vs Pro).',
      `A React pricing component:\n\n\`\`\`jsx\n${REACT}\n\`\`\``);
    saveArtifact({ kind: 'react', code: REACT, title: 'Off Grid AI — pricing', projectId: PROJECT_ID });

    // 4) Image — seed a real PNG into generated-images + an image chat message.
    try {
      const imgDir = path.join(app.getPath('userData'), 'generated-images');
      fs.mkdirSync(imgDir, { recursive: true });
      const dest = path.join(imgDir, 'offgrid-demo-mark.png');
      const srcCandidates = [
        path.join(app.getAppPath(), 'resources', 'icon.png'),
        path.join(process.resourcesPath || '', 'icon.png'),
      ];
      const src = srcCandidates.find((p) => fs.existsSync(p));
      if (src && !fs.existsSync(dest)) fs.copyFileSync(src, dest);
      if (fs.existsSync(dest)) {
        chat('Brand mark (image)', 'Generate the Off Grid AI brand mark.',
          'Generated for: Off Grid AI brand mark', { image: dest });
      }
    } catch (e) { console.error('[seed] image', e); }

    // 5) Voice + Speech — a speakable assistant reply (test TTS via the speak
    //    button; record a voice note to test STT).
    chat('Voice & speech', 'Tell me about Off Grid in one line I can listen to.',
      'Off Grid AI is private, on-device AI — your models and your data never leave your machine. Tap the speaker to hear this, or hold the mic to talk back.');

    // 6) Skills — a manual /skill pack + a chat that uses it.
    saveSkill({
      name: 'offgrid-pitch',
      description: 'Rewrite text as a crisp, on-brand Off Grid one-liner.',
      instructions: 'Rewrite the input as a single confident sentence in the Off Grid voice: private, on-device, no cloud. No hype, no emojis.',
    });
    chat('Skills', '/offgrid-pitch we run AI models on your computer without the internet',
      'Off Grid AI runs open models entirely on your device — no cloud, no accounts, nothing ever leaves your machine.');

    // 7) Connectors — add a demo MCP server (no-auth) so Integrations has an entry.
    if (!listConnectors().some((c) => c.name === 'Demo MCP (Everything)')) {
      addConnector({ name: 'Demo MCP (Everything)', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] });
    }
    chat('Connectors', 'List the tools available from my connected MCP server.',
      'Your "Demo MCP" exposes example tools (echo, add, longRunningOperation, …). Turn Connectors on in the composer to call them right from chat — reads run inline.');

    saveSetting('demo:seeded', true);
    console.log('[seed] demo project seeded ✓');
  } catch (e) {
    console.error('[seed] failed', e);
  }
}
