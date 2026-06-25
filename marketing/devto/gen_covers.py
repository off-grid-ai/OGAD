#!/usr/bin/env python3
"""Generate charcoal-style dev.to cover images via OpenRouter -> Gemini.

Style: hand-drawn charcoal on white paper (the Wednesday illustration standard),
loose sketchy strokes, grey only, white background, sparse hand-lettered charcoal
capital labels. Recurring Off Grid motif: a device that runs on its own with the
cloud cut off. Idempotent: skips slugs whose cover already exists.
"""
import os, sys, json, base64, urllib.request, concurrent.futures as cf

KEY = None
for line in open("/Users/user/wednesday/cro/.env"):
    if line.startswith("LLM_API_KEY="):
        KEY = line.split("=", 1)[1].strip()
MODEL = "google/gemini-3-pro-image"
OUT = "covers"
os.makedirs(OUT, exist_ok=True)

PREAMBLE = (
    "Charcoal drawing on plain white paper, landscape orientation, wide banner, "
    "aspect ratio 1024:572 (roughly 16:9). Hand-drawn, sketchy, loose charcoal "
    "strokes, no color, no shading beyond charcoal grey. Pure white background, no "
    "border. This illustration uses a few labels, hand-lettered in rough charcoal "
    "capitals, sparse and clear, only the labels named below and nothing more. "
    "Expressive but readable. Generous whitespace. "
)

# slug -> (scene, [labels])
SCENES = {
 "how-to-run-llms-locally-mac":
  ("A laptop drawn open on a desk, its screen filled with rough charcoal lines of a chat conversation. "
   "A thick cable runs from the laptop toward a cloud in the corner, but the cable is clearly cut, and the cloud is crossed out with an X. "
   "Inside the laptop body sits a small contained engine, like a flame in a hearth, tended by a tiny figure.",
   ["RUNS ON YOUR MAC", "NO CLOUD", "OFF GRID"]),
 "how-to-run-llms-locally-windows":
  ("A desktop tower and monitor drawn on a desk, the monitor showing rough charcoal chat text. "
   "A graphics card sits inside the open tower with a small contained flame on it. A cable to a corner cloud is cut, the cloud crossed out.",
   ["RUNS ON YOUR PC", "ON YOUR GPU", "OFF GRID"]),
 "how-to-run-local-ai-mac":
  ("A laptop at the center with three things flowing out of its screen: a chat bubble, a small framed picture, and a sound wave. "
   "A cut cable trails to a crossed-out cloud in the corner. A tiny figure tends a contained flame inside the laptop.",
   ["CHAT  IMAGES  VOICE", "ALL ON DEVICE", "OFF GRID"]),
 "how-to-run-local-ai-windows":
  ("A desktop PC with monitor showing three flows out of the screen: a chat bubble, a framed image, a sound wave. "
   "A cut cable to a crossed-out corner cloud. A contained flame glows inside the tower.",
   ["CHAT  IMAGES  VOICE", "ALL ON DEVICE", "OFF GRID"]),
 "how-to-generate-ai-images-locally-mac":
  ("A laptop whose screen becomes an artist's canvas on an easel, a charcoal hand sketching a picture out of the screen. "
   "A cut cable runs to a crossed-out cloud in the corner.",
   ["IMAGES ON YOUR MAC", "NO CLOUD", "OFF GRID"]),
 "how-to-generate-ai-images-locally-windows":
  ("A desktop PC and monitor; the monitor becomes a canvas on an easel with a charcoal hand painting an image. "
   "A graphics card with a small flame sits in the open tower. A cut cable to a crossed-out cloud.",
   ["IMAGES ON YOUR PC", "ON YOUR GPU", "OFF GRID"]),
 "how-to-run-stable-diffusion-desktop":
  ("A laptop with an easel growing from its screen, several small framed pictures stacked beside it. "
   "A cut cable to a crossed-out corner cloud. A contained flame inside the laptop.",
   ["STABLE DIFFUSION", "ON DEVICE", "OFF GRID"]),
 "how-to-run-juggernaut-xl-locally":
  ("A laptop with an easel from its screen showing a realistic portrait sketched in charcoal. "
   "A cut cable to a crossed-out cloud. A small contained flame inside the laptop.",
   ["JUGGERNAUT XL", "PHOTOREAL, LOCAL", "OFF GRID"]),
 "how-to-run-realvisxl-lightning-locally":
  ("A laptop with an easel from its screen, a realistic image and a bold lightning bolt beside it for speed. "
   "A cut cable to a crossed-out cloud.",
   ["REALVISXL LIGHTNING", "FAST, LOCAL", "OFF GRID"]),
 "how-to-run-realvisxl-locally":
  ("A laptop with an easel from its screen showing a realistic photographic scene in charcoal. "
   "A cut cable to a crossed-out corner cloud.",
   ["REALVISXL 5.0", "PHOTOREAL, LOCAL", "OFF GRID"]),
 "how-to-run-pony-diffusion-locally":
  ("A laptop with an easel from its screen showing a stylized character drawing. "
   "A cut cable to a crossed-out cloud. Small tags scattered like prompt keywords.",
   ["PONY DIFFUSION XL", "ON DEVICE", "OFF GRID"]),
 "how-to-run-animagine-xl-locally":
  ("A laptop with an easel from its screen showing an anime-style character sketched in charcoal. "
   "A cut cable to a crossed-out cloud.",
   ["ANIMAGINE XL", "ANIME, LOCAL", "OFF GRID"]),
 "how-to-run-dreamshaper-xl-turbo-locally":
  ("A laptop with an easel from its screen showing an artistic illustration, a lightning bolt for turbo speed beside it. "
   "A cut cable to a crossed-out cloud.",
   ["DREAMSHAPER TURBO", "FAST ART, LOCAL", "OFF GRID"]),
 "how-to-run-illustrious-xl-locally":
  ("A laptop with an easel from its screen showing an illustration, with small danbooru-style tag cards beside it. "
   "A cut cable to a crossed-out cloud.",
   ["ILLUSTRIOUS XL", "ON DEVICE", "OFF GRID"]),
 "best-gguf-image-models-local":
  ("A laptop in the center; from its screen an easel, and beside it a neat shelf of several small labeled model boxes, each compact. "
   "A cut cable to a crossed-out cloud. A small flame contained inside the laptop showing efficiency.",
   ["GGUF MODELS", "SMALL + FAST", "ALL LOCAL", "OFF GRID"]),
 "how-to-run-gemma-locally":
  ("A laptop showing charcoal chat text on screen, a small labeled cube on the desk beside it for the model. "
   "A cut cable to a crossed-out corner cloud.",
   ["GEMMA, LOCAL", "NO CLOUD", "OFF GRID"]),
 "how-to-run-qwen-locally":
  ("A laptop showing charcoal chat text and a few code brackets on screen, a labeled model cube beside it. "
   "A cut cable to a crossed-out cloud.",
   ["QWEN, LOCAL", "NO CLOUD", "OFF GRID"]),
 "ollama-alternative-local":
  ("A laptop with a friendly window UI on screen running chat, an image, and a sound wave; a plain terminal box sits small to one side. "
   "A cut cable to a crossed-out cloud.",
   ["BEYOND THE TERMINAL", "CHAT + IMAGES + VOICE", "OFF GRID"]),
 "lm-studio-alternative":
  ("A laptop showing a chat plus a small image and a document, an open-source padlock-open mark in the corner. "
   "A cut cable to a crossed-out cloud.",
   ["LOCAL + OPEN SOURCE", "ON DEVICE", "OFF GRID"]),
 "local-chatgpt-alternative":
  ("A laptop showing a chat conversation, with a small image and a sound wave beside it; no account needed, shown by a crossed-out login box. "
   "A cut cable to a crossed-out cloud.",
   ["CHATGPT, BUT LOCAL", "NO ACCOUNT", "OFF GRID"]),
 "local-ai-image-studio":
  ("A laptop as a full art studio: an easel from the screen, a palette of style cards, a stack of finished frames in a gallery row. "
   "A cut cable to a crossed-out cloud.",
   ["LOCAL IMAGE STUDIO", "NO SUBSCRIPTION", "OFF GRID"]),
 "transcribe-meetings-locally":
  ("A laptop showing a video-call window with two rough figures, and a long transcript scroll unspooling from the bottom of the screen. "
   "A cut cable to a crossed-out cloud. A small recording dot on the screen edge.",
   ["MEETINGS, TRANSCRIBED", "ON DEVICE", "OFF GRID"]),
 "private-ai-meeting-notetaker":
  ("A laptop showing a video call of two figures, a notepad with summary bullets beside it, a clear recording-indicator dot. "
   "A cut cable to a crossed-out cloud.",
   ["PRIVATE NOTETAKER", "CONSENT FIRST", "OFF GRID"]),
 "voice-to-text-locally":
  ("A microphone on the desk with a charcoal sound wave flowing into a laptop screen, turning into lines of text. "
   "A cut cable to a crossed-out cloud.",
   ["VOICE TO TEXT", "ON DEVICE", "OFF GRID"]),
 "text-to-speech-locally":
  ("A laptop screen with lines of text turning into a sound wave flowing out of a small speaker on the desk. "
   "A cut cable to a crossed-out cloud.",
   ["TEXT TO SPEECH", "ON DEVICE", "OFF GRID"]),
 "local-ai-second-brain":
  ("A laptop wired to a large head-and-brain silhouette beside it; the brain is drawn as shelves of memories, with small entity cards and a day-timeline. "
   "A cut cable to a crossed-out cloud.",
   ["YOUR SECOND BRAIN", "100% OFFLINE", "OFF GRID"]),
 "chat-with-documents-locally":
  ("A laptop with a stack of documents feeding into its screen, a chat bubble coming out with a magnifier and a cited quote mark. "
   "A cut cable to a crossed-out cloud.",
   ["CHAT WITH YOUR DOCS", "OFFLINE RAG", "OFF GRID"]),
 "connect-notion-linear-jira-local-ai":
  ("A laptop in the center with three labeled tool boxes plugged into it by cables, and a gate with a checkmark in front showing approval. "
   "A cut cable to a crossed-out cloud.",
   ["NOTION  LINEAR  JIRA", "APPROVAL-GATED", "OFF GRID"]),
 # gateway articles
 "local-openai-compatible-api":
  ("A central server box on the desk labeled with a port number, many short cables fanning out to small app icons around it. "
   "A cut cable to a crossed-out cloud. A key icon crossed out to show no API key needed.",
   ["LOCAL OPENAI API", "127.0.0.1:7878", "NO KEYS", "OFF GRID"]),
 "point-your-ide-at-local-ai":
  ("A code editor window on a laptop connected by a short cable to a small local server box on the same desk. "
   "A cut cable to a crossed-out cloud.",
   ["POINT YOUR IDE HERE", "127.0.0.1:7878", "OFF GRID"]),
 "one-local-api-all-modalities":
  ("A central hub box on the desk with five labeled ports fanning out: a chat bubble, an eye, a framed image, a sound wave, and a vector dot-grid. "
   "A cut cable to a crossed-out cloud.",
   ["ONE LOCAL API", "TEXT VISION IMAGE VOICE", "OFF GRID"]),
 "local-ai-models-as-mcp-tools":
  ("A laptop's local models drawn as labeled tools on a pegboard, a cable handing them to an MCP client window. "
   "A cut cable to a crossed-out cloud.",
   ["MODELS AS MCP TOOLS", "LOCAL, NO CLOUD", "OFF GRID"]),
 # positioning articles
 "only-local-multimodal-ai":
  ("A single laptop at the center drawn as a hub, with many small panels around it: a chat bubble, an eye, a framed image, a sound wave, a document, a brain. "
   "Every panel connects inward to the one laptop. A cut cable to a crossed-out corner cloud.",
   ["ONE APP, EVERY MODALITY", "ALL LOCAL", "OFF GRID"]),
 "fully-open-source-private-ai":
  ("A laptop drawn inside a thick protective enclosure like a strongbox, an open padlock on it marked with an open-source mark. "
   "A cut cable to a crossed-out cloud. Nothing flows out. A tiny figure tends a contained flame inside.",
   ["OPEN SOURCE", "NOTHING LEAVES", "OFF GRID"]),
 "fast-local-ai-text-and-images":
  ("A laptop with a bold charcoal lightning bolt across it, a chat bubble and a framed image both shooting out fast with motion lines. "
   "A cut cable to a crossed-out cloud, with a tiny crossed-out clock to show no waiting.",
   ["FAST, LOCAL", "NO QUEUE  NO CLOUD", "OFF GRID"]),
 "all-in-one-local-voice-ai":
  ("A laptop with a microphone on one side feeding a sound wave into text on the screen, and a speaker on the other side with text turning into a sound wave out. "
   "A cut cable to a crossed-out cloud.",
   ["VOICE IN + VOICE OUT", "ON DEVICE", "OFF GRID"]),
 "local-ai-skills-automation":
  ("A laptop with a row of labeled skill cards filed beside it, a small clock and a bell showing triggers, an arrow from a card running an action on the screen. "
   "A cut cable to a crossed-out cloud.",
   ["REUSABLE SKILLS", "TRIGGER -> ACTION", "OFF GRID"]),
 "local-ai-artifacts":
  ("A laptop whose screen splits into code on the left and a live rendered mini-app, chart, and diagram on the right. "
   "A cut cable to a crossed-out cloud.",
   ["LIVE ARTIFACTS", "RENDERED LOCALLY", "OFF GRID"]),
 "local-code-sandbox":
  ("A laptop screen showing code running inside a clearly drawn glass box, the box sealed, with a cut wire and a crossed-out cloud showing the sandbox cannot reach the network or files. ",
   ["SANDBOXED PREVIEW", "NO NETWORK  NO FILES", "OFF GRID"]),
 "local-ai-connector-support":
  ("A laptop in the center with several labeled tool boxes plugged in by cables, and a clear gate with a checkmark in front of the laptop showing every action is approved first. "
   "A cut cable to a crossed-out cloud.",
   ["CONNECTORS", "APPROVAL-GATED", "OFF GRID"]),
}

def prompt_for(slug):
    scene, labels = SCENES[slug]
    lab = "; ".join(labels)
    return (PREAMBLE + "SCENE: " + scene + " "
            "The labels to hand-letter in rough charcoal capitals, sparse, are: " + lab + ". "
            "No other text anywhere. The cut cable and crossed-out cloud are load-bearing: they "
            "mean the machine works on its own with nothing leaving it.")

def gen(slug):
    dest = os.path.join(OUT, slug + ".jpg")
    if os.path.exists(dest) and os.path.getsize(dest) > 10000:
        return slug, "skip"
    body = json.dumps({"model": MODEL,
                       "messages": [{"role": "user", "content": prompt_for(slug)}],
                       "modalities": ["image", "text"]}).encode()
    for attempt in range(3):
        try:
            req = urllib.request.Request("https://openrouter.ai/api/v1/chat/completions",
                data=body, headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"})
            d = json.load(urllib.request.urlopen(req, timeout=240))
            imgs = d["choices"][0]["message"].get("images") or []
            if not imgs:
                continue
            b64 = imgs[0]["image_url"]["url"].split(",", 1)[1]
            open(dest, "wb").write(base64.b64decode(b64))
            return slug, "ok"
        except Exception as e:
            last = str(e)[:160]
    return slug, f"FAIL {last}"

slugs = sorted(SCENES.keys())
# only generate for articles that actually exist as .md
slugs = [s for s in slugs if os.path.exists(s + ".md")]
print(f"generating {len(slugs)} covers with {MODEL}")
with cf.ThreadPoolExecutor(max_workers=4) as ex:
    for slug, status in ex.map(gen, slugs):
        print(f"  {status:>6}  {slug}")
print("done")
