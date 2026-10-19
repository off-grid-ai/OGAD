// Shared helpers for the social clones (akkoma, lemmy, humhub): text generators, SQL and HTTP helpers.

export const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const untag = (s) => { let t = s; let p; do { p = t; t = t.replace(/<[^>]+>/g, '') } while (t !== p); return t }
/** Visible text of an HTML fragment; &amp; is decoded last, so an escaped entity is read once. */
export const plain = (html) => untag(html.replace(/<br\s*\/?>/g, ' ')).replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
/** First words of a text, enough to recognise it. */
export const head = (s, n = 6) => s.split(/\s+/).slice(0, n).join(' ')

/** Run SQL through stdin (no shell quoting); rows as arrays of strings. */
export function sql(sh, db, q, engine = 'pg') {
  const cmd = engine === 'pg' ? `su postgres -c 'psql -d ${db} -tA -F "\t" -v ON_ERROR_STOP=1'` : `mysql -N -B ${db}`
  const out = sh(`${cmd} <<'__SQL__'\n${q}\n__SQL__`)
  return out.split('\n').filter((l) => l.length).map((l) => l.split('\t'))
}
export const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`

export function getJson(sh, url, host, headers = []) {
  const h = [`-H 'Host: ${host}'`, ...headers.map((x) => `-H '${x}'`)].join(' ')
  return JSON.parse(sh(`curl -s --max-time 20 ${h} '${url}'`))
}

const TOPICS = {
  cricket: ['Big win for the home side tonight', 'That last over was pure drama', 'Who else stayed up for the super over', 'Our spinners carried the match today'],
  food: ['Made filter coffee the slow way this morning', 'Trying a new dal recipe tonight', 'Best street food I had this year was in Indore', 'Sunday lunch: rajma chawal and a nap'],
  travel: ['Booked a train to the hills for next weekend', 'Monsoon trek planned, gear check done', 'Airport lounges are overrated, change my mind', 'Two days in Hampi were not enough'],
  tech: ['Shipped a small fix that saved us an hour a day', 'Reading about on-device models today', 'Finally moved our builds to the new runners', 'Pair programming session went really well'],
  books: ['Started a new mystery novel last night', 'Our book club picked a memoir this month', 'Finished three books on the beach this week'],
  fitness: ['Ran my first 10K without stopping', 'Morning yoga before the meetings', 'Rest day, legs are done'],
  work: ['Meeting-free Friday is the best idea we had', 'Writing the quarterly plan today', 'Hiring two engineers for the platform team'],
}
const TAGS = { cricket: ['cricket', 'IPL'], food: ['food', 'cooking'], travel: ['travel'], tech: ['AI', 'tech'], books: ['books', 'reading'], fitness: ['fitness', 'running'], work: ['remotework', 'productivity'] }
const REPLIES = ['Totally agree with this', 'Great point, thanks for sharing', 'Ha, same here', 'Love this, saving it', 'Where was this taken', 'Congrats, well deserved', 'Interesting, tell me more', 'This made my day', 'Count me in next time', 'Good luck with it']

export function statusText(rng, { tags = true } = {}) {
  const topic = rng.pick(Object.keys(TOPICS))
  let t = `${rng.pick(TOPICS[topic])}${rng.pick(['.', '!', '.', ' :)'])}`
  if (tags && rng.chance(0.6)) t += ` #${rng.pick(TAGS[topic])}`
  return t
}
export const replyText = (rng) => `${rng.pick(REPLIES)}${rng.pick(['!', '.', ' :)', ''])}`
export const commentText = replyText

export const BIOS = ['Product person. Coffee, cricket and long walks.', 'Engineer by day, home cook by night.', 'Building things on the web. Opinions are my own.',
  'Designer who loves trains and old maps.', 'Data, books and the occasional 10K.', 'Founder. Learning in public.', 'Writer and amateur photographer from Pune.',
  'Remote worker, plant parent, chai enthusiast.']
