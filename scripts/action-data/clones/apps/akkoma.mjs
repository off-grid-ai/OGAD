// Akkoma with the Mastodon web UI (glitch-soc mastodon-fe, single-column) on social.farm.test:
// a Twitter/X-like microblog. Posts, replies, likes (favourites), boosts, bookmarks, follows, search.
// State checks use Akkoma's own Mastodon API (public endpoints) and its PostgreSQL DB.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { esc, plain, head, sql, sqlStr, getJson, statusText, replyText } from './social-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
const ORIGIN = 'http://social.farm.test'
const HOST = 'social.farm.test'
export const ME = 'asha_rao'
const TAGS = ['cricket', 'IPL', 'food', 'cooking', 'travel', 'AI', 'startups', 'climate', 'books', 'music', 'photography', 'fitness', 'running', 'remotework', 'gaming', 'recipes', 'yoga', 'reading']
const TOPIC_TAGS = { cricket: ['cricket', 'IPL', 'TeamIndia'], food: ['food', 'cooking', 'recipes'], travel: ['travel', 'wanderlust', 'roadtrip'], AI: ['AI', 'MachineLearning', 'LLM'],
  startups: ['startups', 'founders', 'SaaS'], climate: ['climate', 'sustainability', 'solar'], books: ['books', 'reading', 'bookclub'], music: ['music', 'concerts', 'playlist'],
  photography: ['photography', 'streetphotography', 'nature'], fitness: ['fitness', 'running', 'yoga'], 'remote work': ['remotework', 'productivity', 'WFH'], gaming: ['gaming', 'indiegames', 'esports'] }

const api = (sh, path) => getJson(sh, `http://127.0.0.1:7140${path}`, HOST)
const acct = (sh, nick) => api(sh, `/api/v1/accounts/lookup?acct=${nick}`)
const db = (sh, q) => sql(sh, 'akkoma', q)
const myStatuses = (sh, n = 10) => api(sh, `/api/v1/accounts/${acct(sh, ME).id}/statuses?limit=${n}`)
const shown = (s) => `${s.account.display_name}, ${plain(s.content)}`
/** The status as the web UI names it: "Display Name, text, date, nick". */
const card = (s) => ({ inside: new RegExp(`^${esc(shown(s))}, `), insideRole: 'generic' })
const unique = (list) => list.filter((s, i) => list.findIndex((o) => shown(o) === shown(s)) === i && list.filter((o) => shown(o) === shown(s)).length === 1)
const statuses = (sh, path) => api(sh, path).filter((s) => !s.reblog && s.account.acct !== ME)
const tagTimeline = (sh, tag) => unique(statuses(sh, `/api/v1/timelines/tag/${tag}?limit=20`)).slice(0, 6)
const likedBy = (sh, id) => api(sh, `/api/v1/statuses/${id}/favourited_by`).map((a) => a.acct)
const people = (sh) => db(sh, `select nickname, name from users where local and nickname not in ('${ME}', 'farmadmin') and is_active order by nickname`).map(([nick, name]) => ({ nick, name }))
const following = (sh) => new Set(db(sh, `select u2.nickname from following_relationships f join users u1 on u1.id = f.follower_id join users u2 on u2.id = f.following_id where u1.nickname = '${ME}' and f.state = 2`).map((r) => r[0]))
const quote = (s) => `"${head(plain(s.content), 7)}${plain(s.content).split(/\s+/).length > 7 ? '…' : ''}"`

export default {
  name: 'akkoma',
  family: 'social',
  origin: ORIGIN,
  portOffset: 40,
  explorePaths: ['/home', '/public/local', '/notifications', '/@asha_rao', '/favourites', '/explore', '/bookmarks'],
  async reset({ sh }) { sh('bash /workspace/action-data-gen/scripts/clones/farm/akkoma/reset.sh') },
  async login({ page, sleep }) {
    // Sign in through Akkoma's OAuth page (as the web UI does), then switch the UI to one column, like X.
    await page.context().clearCookies()
    await page.goto(`${ORIGIN}/web`)
    await page.evaluate(() => { try { localStorage.clear() } catch { /* storage may be unavailable */ } })
    await page.goto(`${ORIGIN}/web`)
    await page.waitForSelector('input[type=password]', { timeout: 30_000 })
    await page.fill('input[type=text]', ME)
    await page.fill('input[type=password]', ACCOUNTS.password)
    await Promise.all([page.waitForURL(/\/web/, { timeout: 30_000 }), page.click('button[type=submit]')])
    await page.waitForSelector('.columns-area, .ui', { timeout: 30_000 })
    await page.evaluate(() => localStorage.setItem('mastodon-settings', JSON.stringify({ layout: 'single', show_reply_count: true })))
    await page.goto(`${ORIGIN}/home`)
    await page.waitForSelector('.columns-area, .ui', { timeout: 30_000 })
    await sleep(1500)
  },
  tasks: {
    post_status: async ({ rng }) => {
      const text = statusText(rng)
      const goal = rng.pick([`Post "${text}" on Chirp.`, `Publish a new post that says: ${text}`, `Share this status: "${text}"`, `Write a post: ${text}`])
      return {
        goal, start: '/home',
        plan: [{ title: 'Type the post in the compose box', check: `the compose box shows "${head(text, 4)}"` }, { title: 'Click Publish!', check: 'the post appears on the home timeline' }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: '', nth: 1, only: true }, text },
          { plan: 2, do: 'click', target: { role: 'button', name: 'Publish!' }, settle: 2000 }
        ],
        answer: `Posted "${text}".`,
        verify: async ({ sh }) => myStatuses(sh, 3).some((s) => plain(s.content) === text)
      }
    },
    reply_post: async ({ rng, sh }) => {
      const tag = rng.pick(TAGS)
      const s = rng.pick(tagTimeline(sh, tag).slice(0, 4))
      if (!s) return null
      const text = replyText(rng)
      const who = s.account.display_name
      return {
        goal: rng.pick([`On the #${tag} page, reply "${text}" to ${who}'s post ${quote(s)}.`, `Reply to ${who}'s post ${quote(s)} under #${tag} with: ${text}`, `Answer ${who} (${quote(s)}, tagged #${tag}) saying "${text}".`]),
        start: `/tags/${tag}`, startWait: 3000,
        plan: [{ title: `Click Reply on ${who}'s post`, check: `the compose box replies to @${s.account.acct}` }, { title: 'Type the reply', check: `the compose box shows "${head(text, 3)}"` }, { title: 'Click Publish!', check: 'the reply is posted' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: /^Reply/, ...card(s) } },
          { plan: 2, do: 'type', target: { role: 'textbox', name: '', nth: 1, only: true }, text: `@${s.account.acct} ${text}` },
          { plan: 3, do: 'click', target: { role: 'button', name: 'Publish!' }, settle: 2000 }
        ],
        answer: `Replied "${text}" to ${who}.`,
        verify: async ({ sh }) => myStatuses(sh, 3).some((m) => m.in_reply_to_id === s.id && plain(m.content).includes(text))
      }
    },
    like_post: async ({ rng, sh }) => {
      const tag = rng.pick(TAGS)
      const s = rng.pick(tagTimeline(sh, tag).filter((x) => !x.favourited && !likedBy(sh, x.id).includes(ME)).slice(0, 4))
      if (!s) return null
      const who = s.account.display_name
      return {
        goal: rng.pick([`Like ${who}'s post ${quote(s)} on the #${tag} page.`, `Favourite the post by ${who} tagged #${tag}: ${quote(s)}.`, `Open #${tag} and like ${who}'s post ${quote(s)}.`]),
        start: `/tags/${tag}`, startWait: 3000,
        plan: [{ title: `Click Favourite on ${who}'s post`, check: 'the star is filled' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'button', name: 'Favourite', ...card(s) } }],
        answer: `Liked ${who}'s post.`,
        verify: async ({ sh }) => likedBy(sh, s.id).includes(ME)
      }
    },
    like_topic: async ({ rng, sh }) => {
      // X1: train my feed. Like the posts about one topic among the newest local posts, and nothing else.
      const list = statuses(sh, '/api/v1/timelines/public?local=true&limit=20').slice(0, 8)
      const topics = Object.entries(TOPIC_TAGS).map(([t, tags]) => [t, list.filter((s) => s.tags.some((x) => tags.map((y) => y.toLowerCase()).includes(x.name.toLowerCase())))]).filter(([, l]) => l.length >= 1 && l.length <= 3)
      if (!topics.length) return null
      const [topic, hits] = rng.pick(topics)
      const targets = unique(list).filter((s) => hits.includes(s))
      if (targets.length !== hits.length || targets.some((s) => likedBy(sh, s.id).includes(ME))) return null
      const before = Number(db(sh, `select count(*) from activities where data->>'type' = 'Like' and actor = (select ap_id from users where nickname = '${ME}')`)[0][0])
      return {
        goal: rng.pick([`On the Local timeline, like only the posts about ${topic} among the newest posts.`, `Train my feed: like every recent ${topic} post on the Local timeline and nothing else.`, `Go through the latest Local posts and favourite just the ones about ${topic}.`]),
        start: '/public/local', startWait: 3000,
        plan: targets.map((s, i) => ({ title: `Favourite ${s.account.display_name}'s ${topic} post`, check: `${i + 1} of ${targets.length} ${topic} posts liked` })),
        steps: targets.map((s, i) => ({ plan: i + 1, do: 'click', target: { role: 'button', name: 'Favourite', ...card(s) } })),
        answer: `Liked ${targets.length} ${topic} post${targets.length > 1 ? 's' : ''}.`,
        verify: async ({ sh }) => {
          const after = Number(db(sh, `select count(*) from activities where data->>'type' = 'Like' and actor = (select ap_id from users where nickname = '${ME}')`)[0][0])
          return after - before === targets.length && targets.every((s) => likedBy(sh, s.id).includes(ME))
        }
      }
    },
    boost_post: async ({ rng, sh }) => {
      const tag = rng.pick(TAGS)
      const s = rng.pick(tagTimeline(sh, tag).filter((x) => !x.reblogged).slice(0, 4))
      if (!s) return null
      const who = s.account.display_name
      return {
        goal: rng.pick([`Boost ${who}'s post ${quote(s)} from #${tag}.`, `Share (boost) the #${tag} post by ${who}: ${quote(s)}.`, `Repost ${who}'s ${quote(s)} to my followers. It is on the #${tag} page.`]),
        start: `/tags/${tag}`, startWait: 3000,
        plan: [{ title: `Click Boost on ${who}'s post`, check: 'the boost icon is active' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'Boost', ...card(s) } }
        ],
        answer: `Boosted ${who}'s post.`,
        verify: async ({ sh }) => api(sh, `/api/v1/statuses/${s.id}/reblogged_by`).some((a) => a.acct === ME)
      }
    },
    bookmark_post: async ({ rng, sh }) => {
      const tag = rng.pick(TAGS)
      const s = rng.pick(tagTimeline(sh, tag).slice(0, 4))
      if (!s) return null
      const who = s.account.display_name
      return {
        goal: rng.pick([`Bookmark ${who}'s post ${quote(s)} on #${tag} so I can read it later.`, `Save ${who}'s #${tag} post ${quote(s)} to my bookmarks.`]),
        start: `/tags/${tag}`, startWait: 3000,
        plan: [{ title: `Click Bookmark on ${who}'s post`, check: 'the bookmark icon is active' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'button', name: 'Bookmark', ...card(s) } }],
        answer: `Bookmarked ${who}'s post.`,
        verify: async ({ sh }) => db(sh, `select count(*) from bookmarks b join users u on u.id = b.user_id join activities a on a.id = b.activity_id join objects o on o.data->>'id' = a.data->>'object' where u.nickname = '${ME}' and o.data->>'id' = ${sqlStr(s.uri)}`)[0][0] === '1'
      }
    },
    follow_user: async ({ rng, sh }) => {
      const f = following(sh)
      const p = rng.pick(people(sh).filter((x) => !f.has(x.nick)))
      if (!p) return null
      return {
        goal: rng.pick([`Follow ${p.name} on Chirp.`, `Find @${p.nick} and follow them.`, `Search for ${p.name} and follow the account.`, `I want to see ${p.name}'s posts. Follow them.`]),
        start: '/home',
        plan: [{ title: `Search for ${p.name}`, check: `textbox "Search or paste URL" = ${p.name}` }, { title: 'Run the search', check: `a profile result for @${p.nick}` }, { title: `Click Follow next to ${p.name}`, check: 'the button changes to Unfollow' }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Search or paste URL' }, text: p.name },
          { plan: 2, do: 'press', key: 'Enter', settle: 2500 },
          { plan: 3, do: 'click', target: { role: 'button', name: 'Follow', inside: new RegExp(`@${p.nick}\\b`), insideDepth: 2 } }
        ],
        answer: `Now following ${p.name}.`,
        verify: async ({ sh }) => following(sh).has(p.nick)
      }
    },
    unfollow_user: async ({ rng, sh }) => {
      const f = following(sh)
      const p = rng.pick(people(sh).filter((x) => f.has(x.nick)))
      if (!p) return null
      return {
        goal: rng.pick([`Unfollow ${p.name}.`, `Stop following @${p.nick}.`, `I no longer want ${p.name}'s posts in my feed. Unfollow them.`]),
        start: `/@${p.nick}`,
        plan: [{ title: `Click Unfollow on ${p.name}'s profile`, check: 'the button shows Follow' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'Unfollow' } }
        ],
        answer: `Unfollowed ${p.name}.`,
        verify: async ({ sh }) => !following(sh).has(p.nick)
      }
    },
    read_followers: async ({ rng, sh }) => {
      const p = rng.pick(people(sh))
      const a = acct(sh, p.nick)
      const what = rng.pick(['followers', 'posts', 'follows'])
      const n = { followers: a.followers_count, posts: a.statuses_count, follows: a.following_count }[what]
      return {
        goal: rng.pick([`How many ${what} does ${p.name} have on Chirp?`, `Look up ${p.name} and tell me their number of ${what}.`, `Find @${p.nick}'s profile. How many ${what}?`]),
        start: '/home', writes: false,
        plan: [{ title: `Search for ${p.name}`, check: `textbox "Search or paste URL" = ${p.name}` }, { title: 'Run the search', check: `a profile result for @${p.nick}` }, { title: `Open ${p.name}'s profile`, check: `the profile shows the ${what} count` }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Search or paste URL' }, text: p.name },
          { plan: 2, do: 'press', key: 'Enter', settle: 2500 },
          { plan: 3, do: 'click', target: { role: 'link', name: new RegExp(`@${p.nick}$`) }, settle: 2500 }
        ],
        answer: `${p.name} has ${n} ${what}.`,
        verify: async ({ sh }) => { const b = acct(sh, p.nick); return ({ followers: b.followers_count, posts: b.statuses_count, follows: b.following_count })[what] === n }
      }
    },
    read_likes: async ({ rng, sh }) => {
      const tag = rng.pick(TAGS)
      const s = rng.pick(tagTimeline(sh, tag).slice(0, 4))
      if (!s) return null
      const who = s.account.display_name
      return {
        goal: rng.pick([`How many likes does ${who}'s post ${quote(s)} on #${tag} have?`, `Open ${who}'s #${tag} post ${quote(s)} and tell me how many favourites it got.`]),
        start: `/tags/${tag}`, startWait: 3000, writes: false,
        plan: [{ title: `Open ${who}'s post`, check: 'the post page shows its counts' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'generic', text: new RegExp(`^${esc(plain(s.content))}$`), ...card(s) }, settle: 2500 }],
        answer: `It has ${s.favourites_count} like${s.favourites_count === 1 ? '' : 's'}.`,
        verify: async ({ sh }) => api(sh, `/api/v1/statuses/${s.id}`).favourites_count === s.favourites_count
      }
    },
    delete_post: async ({ rng, sh }) => {
      const mine = api(sh, `/api/v1/accounts/${acct(sh, ME).id}/statuses?limit=20&exclude_reblogs=true`).filter((s) => !s.in_reply_to_id)
      const s = rng.pick(mine.slice(0, 8))
      if (!s) return null
      return {
        goal: rng.pick([`Delete my post ${quote(s)}.`, `Remove the post where I wrote ${quote(s)}.`, `Take down my status ${quote(s)}.`]),
        start: `/@${ME}/${s.id}`,
        plan: [{ title: 'Open the post menu (More)', check: 'the menu shows Delete' }, { title: 'Click Delete', check: 'a confirm dialog' }, { title: 'Confirm Delete', check: 'the post is gone' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'More' } },
          { plan: 2, do: 'click', target: { role: 'button', name: 'Delete' } },
          { plan: 3, do: 'click', target: { role: 'button', name: 'Delete', insideRole: 'dialog', inside: /./ }, settle: 2000 }
        ],
        answer: `Deleted the post ${quote(s)}.`,
        verify: async ({ sh }) => !myStatuses(sh, 30).some((m) => m.id === s.id)
      }
    }
  }
}
