// Which tools a request is FOR, decided by MiniLM against example requests.
//
// A one-line tool description is a poor target for a small embedding model: "draw a dog" scored
// 0.20 against generate_image's description (under the 0.24 floor), while "Create a 3D starfield in
// a single HTML file… Render hundreds of stars" scored the same. Example requests separate them:
// each tool below lists requests it serves, and ANSWER_IN_CHAT lists requests the model answers in
// the chat itself (code, HTML pages, prose, questions, greetings). A tool is offered when the
// request sits closer to its examples than to the chat answers. Extend the examples to teach it;
// do not add word rules.

/** Code and pages the model writes itself, in the chat. A long request is also matched against
 *  these sentence by sentence: "Make an interactive fireworks show in one small HTML file… Dark
 *  night sky. Use vanilla JavaScript and canvas" averages out to a picture as a whole, but its
 *  last sentence is plainly code. */
export const BUILD_IN_CHAT = [
  'write an HTML file with a canvas animation',
  'build a three.js scene in a single HTML page',
  'create a small javascript game in one file',
  'build a snake game',
  'make a landing page in html and css',
  'make an interactive web page with vanilla js',
  'create a dashboard with charts in react',
  'write a webgl shader that looks like water',
  'build a todo app with local storage',
  'make a portfolio site with a dark theme',
  'create a 2d platformer I can play in the browser',
  'write a css animation for a button hover',
  'build a weather widget component',
  'write a python script that renames files',
  'write a bash script to back up my folder',
  'write a sql query for the top customers',
  'write a react component for a todo list',
  'write an SVG of a star in code',
  'fix this bug in my code',
  'build an audio visualiser with the web audio api',
  'make a drawing app with a canvas and brush sizes',
  'write a function that resizes images',
  'refactor this function to be faster'
]

/** Requests the model answers in the chat, with no tool. */
export const ANSWER_IN_CHAT = [
  ...BUILD_IN_CHAT,
  // Writing, questions and conversation
  'write an essay about climate change',
  'write a poem about the sea',
  'draft an email to my landlord',
  'write a cover letter for a design job',
  'explain how transformers work',
  'explain this stack trace',
  'why does my app crash on startup',
  'what should I have for dinner',
  'recommend a good book',
  'what is the capital of france',
  'how do i make sourdough bread',
  'compare these two laptops for me',
  'give me ideas for a birthday party',
  'hi',
  'hello, how are you',
  'thanks, that helps',
  'tell me a joke',
  'summarise this article',
  'translate this into spanish'
]

/** Requests each routed tool serves. Tools not listed here route by their description. */
export const TOOL_INTENT_EXAMPLES: Readonly<Record<string, readonly string[]>> = {
  generate_image: [
    'draw a dog',
    'paint a sunset over the ocean',
    'make a picture of a cat in space',
    'design a logo for my coffee shop',
    'design an app icon with a cloud',
    'make an icon for my productivity app',
    'a flat vector illustration of a rocket',
    'create a poster for a jazz night',
    'generate a photo of a mountain cabin',
    'sketch a portrait of an old man',
    'an illustration of a dragon',
    'create a wallpaper with neon mountains',
    'show me an image of a red sports car',
    'a cartoon of my cat wearing sunglasses',
    'make a greeting card picture with balloons',
    'a watercolour of a forest in autumn',
    'a photorealistic shot of a bowl of ramen',
    'make an anime style character with blue hair',
    'create album cover art for a synthwave record',
    'a pixel art sprite of a knight',
    'render a 3d image of a futuristic car',
    'make a thumbnail image for my youtube video',
    'turn this into a picture: a castle on a cliff at night',
    'make a meme image of a surprised cat'
  ],
  generate_video: [
    'make a video of a dog running on the beach',
    'generate a short clip of waves crashing on rocks',
    'animate this picture',
    'turn the last image into a video',
    'make the image move',
    'a slow motion video of rain on a window',
    'create a moving clip of a city at night',
    'make a short video of a rocket taking off',
    'bring this photo to life with motion'
  ],
  make_film: [
    'make a film about a robot who learns to paint',
    'make a short movie about two friends on a road trip',
    'create a story video about a lost kitten finding home',
    'make a film with several shots of a day at the farm',
    'turn this idea into a short film',
    'make a movie trailer about a heist in space',
    'tell a story as a video with a few scenes'
  ],
  web_use: [
    'book a table on opentable for tonight',
    'order this on amazon',
    'buy the cheapest usb-c cable online',
    'add these groceries to my cart on the supermarket site',
    'fill in the form on this website',
    'log in to my bank website and check the balance',
    'find flights to tokyo on google flights',
    'check in for my flight on the airline website',
    'track my parcel on the courier website',
    'buy concert tickets on ticketmaster',
    'reserve a rental car on the hertz website',
    'pay my electricity bill on the provider website',
    'subscribe to the mailing list on their site',
    'cancel my subscription on the account page of the website',
    'post this on linkedin',
    'reply to the latest comment on my instagram post',
    'can you check this site for me',
    'look at example.com and tell me what they sell',
    'go to the website and sign me up',
    'visit stripe.com and look up their pricing',
    'what does their website say about opening hours',
    'go to the store page and find the price of this laptop',
    'read the latest posts on hacker news',
    'browse the top threads on a subreddit',
    'summarise the front page of bbc news',
    'search youtube for a lofi playlist and play it',
    'find a hotel in paris on booking.com for next weekend'
  ],
  computer_use: [
    'open spotify and play my liked songs',
    'change my wallpaper in system settings',
    'clean up my downloads folder',
    'turn on dark mode on my mac',
    'open the pdf in preview and export it',
    'click the send button in slack',
    'share the deck in whatsapp',
    'move these files into a new folder in finder',
    'open notes and write down this list',
    'open the calendar app and add my dentist appointment',
    'open notion and add a new page',
    'send this message in the discord app',
    'resize this image in the photos app',
    'open excel and sort the sheet by date',
    'turn the volume down and mute notifications',
    'empty the bin and free up disk space',
    'rename the files in this folder by date',
    'quit all the open apps',
    'connect to my airpods in bluetooth settings'
  ]
}

/** A routed tool must reach this similarity to its closest example… */
export const TOOL_INTENT_FLOOR = 0.3
/** …and beat the closest chat answer by this much. */
export const TOOL_INTENT_MARGIN = 0.05
/** One sentence asks for a tool on its own when it is this close to the tool's examples (and beats
 *  its own chat answers): "draw a dog. write an HTML file…" is two tasks. A descriptive sentence
 *  inside a build request stays below it ("…a rocket that bursts into colourful sparks" 0.51). */
export const TOOL_INTENT_SENTENCE_FLOOR = 0.6

export type Embed = (text: string) => Promise<number[]>

function dot(a: number[], b: number[]): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0)
  return s
}

const exampleVecCache = new Map<string, Promise<number[]>>()

function embedExample(text: string, embed: Embed): Promise<number[]> {
  let hit = exampleVecCache.get(text)
  if (!hit) {
    hit = embed(text)
    hit.catch(() => exampleVecCache.delete(text))
    exampleVecCache.set(text, hit)
  }
  return hit
}

async function closest(
  query: number[],
  examples: readonly string[],
  embed: Embed
): Promise<number> {
  const vecs = await Promise.all(examples.map((e) => embedExample(e, embed)))
  return Math.max(-1, ...vecs.map((v) => dot(query, v)))
}

/** The routed tools (by name) this request is for, with their scores. `query` is the request's
 *  embedding; `sentences` are the embeddings of its sentences: each is matched against the code
 *  examples, and each can ask for a tool on its own. Tools without examples are not judged here. */
export async function toolIntents(
  query: number[],
  embed: Embed,
  names: readonly string[] = Object.keys(TOOL_INTENT_EXAMPLES),
  sentences: readonly number[][] = []
): Promise<Map<string, number>> {
  let chat = await closest(query, ANSWER_IN_CHAT, embed)
  for (const sentence of sentences)
    chat = Math.max(chat, await closest(sentence, BUILD_IN_CHAT, embed))
  const picked = new Map<string, number>()
  for (const name of names) {
    const examples = TOOL_INTENT_EXAMPLES[name]
    if (!examples) continue
    const score = await closest(query, examples, embed)
    if (score >= TOOL_INTENT_FLOOR && score > chat + TOOL_INTENT_MARGIN) picked.set(name, score)
    // A code sentence must not veto a separate, confident task in another sentence.
    for (const sentence of sentences) {
      const own = await closest(sentence, examples, embed)
      if (own < TOOL_INTENT_SENTENCE_FLOOR) continue
      if (own > (await closest(sentence, ANSWER_IN_CHAT, embed)) + TOOL_INTENT_MARGIN)
        picked.set(name, Math.max(picked.get(name) ?? 0, own))
    }
  }
  return picked
}

/** The request's sentences, for toolIntents. A one-sentence request has none beyond itself. */
export function requestSentences(request: string): string[] {
  const sentences = request
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 3)
  return sentences.length > 1 ? sentences.slice(0, 12) : []
}

/** Test-only: forget cached example embeddings. */
export function _clearToolIntentCache(): void {
  exampleVecCache.clear()
}
