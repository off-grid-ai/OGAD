// Mattermost Team Edition on chat.farm.test: Slack-like team chat (shared postgres, template-DB reset).
// Persona meera.iyer (member of both teams and every seeded channel). Every task is checked in the DB.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
export const ME = 'meera.iyer'
const ORIGIN = 'http://chat.farm.test'

/** Rows of a SQL query against the live Mattermost DB (tab-separated). */
function sql(sh, q) {
  const out = sh(`su postgres -c "psql -d mattermost -tA -F '\t'" <<'SQL'\n${q}\nSQL`)
  return out.split('\n').filter(Boolean).map((l) => l.split('\t'))
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Exact text as a RegExp that tolerates the app's whitespace changes. */
const textRe = (s) => new RegExp(esc(s.slice(0, 60)))
const meId = (sh) => sql(sh, `select id from users where username = ${lit(ME)}`)[0][0]

/** Channels the persona is in (not DMs): [teamName, channelName, displayName, channelId, type]. */
const myChannels = (sh) => sql(sh, `select t.name, c.name, c.displayname, c.id, c.type from channels c join teams t on t.id = c.teamid
  join channelmembers m on m.channelid = c.id join users u on u.id = m.userid where u.username = ${lit(ME)} and c.type in ('O','P') and c.deleteat = 0`)

/** A recent root post that is on screen when the channel opens (the newest ones). */
function recentPost(sh, rng, { withReplies = false, mine = false, withReactions = false } = {}) {
  const chans = myChannels(sh).filter((c) => c[1] !== 'town-square' && c[1] !== 'off-topic')
  const ids = (mine ? chans : [rng.pick(chans)]).map((c) => lit(c[3])).join(',')
  // The 7 newest root posts of each channel (on screen when it opens), with a text unique in that channel.
  const rows = sql(sh, `select * from (select p.id, p.message, u.username, u.firstname || ' ' || u.lastname,
      (select count(*) from posts r where r.rootid = p.id and r.deleteat = 0), p.channelid,
      row_number() over (partition by p.channelid order by p.createat desc) as n,
      (select count(*) from posts d where d.channelid = p.channelid and d.message = p.message) as dup
    from posts p join users u on u.id = p.userid where p.channelid in (${ids}) and p.rootid = '' and p.type = '' and p.deleteat = 0) x where n <= 7 and dup = 1`)
  let pool = rows
  if (withReplies) pool = pool.filter((r) => Number(r[4]) > 0)
  if (mine) pool = pool.filter((r) => r[2] === ME)
  if (withReactions) pool = pool.filter((r) => sql(sh, `select 1 from reactions where postid = ${lit(r[0])} and deleteat = 0 limit 1`).length)
  if (!pool.length) return null
  const [id, message, username, fullName, replies, chId] = rng.pick(pool)
  return { ch: chans.find((c) => c[3] === chId), id, message, username, fullName, replies: Number(replies) }
}

const PROJECTS = ['Atlas', 'Nimbus', 'Kestrel', 'Lotus', 'Orion', 'Saffron', 'Tidal', 'Monarch', 'Zephyr', 'Banyan']
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
function newMessage(rng) {
  const p = rng.pick(PROJECTS); const d = rng.pick(DAYS); const n = rng.int(2, 9)
  return rng.pick([
    `Standup moved to ${rng.int(9, 11)}:30 on ${d}.`, `${p} demo is ready for review.`, `I will share the ${p} notes by ${d}.`,
    `Can we sync on ${p} for ${n * 5} minutes today?`, `${p} build ${n}.${rng.int(0, 9)} is on staging now.`, `Thanks everyone, great work on ${p}!`,
    `Reminder: ${p} retro on ${d} at ${rng.int(2, 5)} PM.`, `I am working from the Pune office on ${d}.`, `Updated the ${p} tracker with ${n} new tickets.`,
    `Who can cover the ${p} review on ${d}?`, `Please add your ${p} questions to the doc before ${d}.`, `Lunch order for ${d}: ${rng.pick(['dosa', 'thali', 'pizza', 'biryani'])}?`,
  ])
}
const REPLIES = ['Thanks, noted.', 'I can help with this.', 'Agreed.', 'Let us discuss in standup.', 'Looks good to me.', 'On it.',
  'Can you share the doc?', 'Great news!', 'I will check and update here.', 'Please loop me in.', 'Works for me.', 'Done.']

const short = (m) => (m.length > 48 ? `${m.slice(0, 45).replace(/\s+\S*$/, '')}...` : m)
const chanStart = (ch) => `/${ch[0]}/channels/${ch[1]}`

export default {
  name: 'mattermost',
  family: 'chat',
  origin: ORIGIN,
  portOffset: 20,
  explorePaths: ['/orbit/channels/town-square', '/orbit/channels/engineering', '/monsoon/channels/sales', '/orbit/threads'],
  async reset({ sh }) { sh('bash /workspace/action-data-gen/scripts/clones/farm/mattermost/reset.sh') },
  async login({ page, sleep }) {
    await page.context().clearCookies()
    await page.goto(`${ORIGIN}/login`)
    await sleep(800)
    if (page.url().includes('/landing')) { await page.getByRole('link', { name: 'View in Browser' }).click(); await page.waitForSelector('#input_loginId') }
    await page.fill('#input_loginId', ME)
    await page.fill('#input_password-input', ACCOUNTS.password)
    await Promise.all([page.waitForURL(/\/channels\//, { timeout: 30_000 }), page.keyboard.press('Enter')])
    await sleep(1500)
  },
  tasks: {
    post_message: async ({ rng, sh }) => {
      const ch = rng.pick(myChannels(sh))
      const text = newMessage(rng)
      const goal = rng.pick([`Post "${text}" in the ${ch[2]} channel.`, `Send a message to ~${ch[1]}: ${text}`, `In ${ch[2]}, write "${text}".`])
      return {
        goal, start: chanStart(ch), answer: `Posted the message in ${ch[2]}.`,
        plan: [{ title: `Type the message in the ${ch[2]} message box`, check: `textbox "Write to ${ch[2]}" = ${text}` }, { title: 'Press Enter to send', check: `text "${text}"` }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: `Write to ${ch[2]}` }, text },
          { plan: 2, do: 'press', key: 'Enter', settle: 1800 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from posts p join users u on u.id = p.userid where u.username = ${lit(ME)} and p.channelid = ${lit(ch[3])} and p.message = ${lit(text)} and p.rootid = ''`).length === 1,
      }
    },
    reply_thread: async ({ rng, sh }) => {
      let post = null
      for (let t = 0; t < 6 && !post; t++) post = recentPost(sh, rng, { withReplies: true })
      if (!post) return null
      const text = rng.pick(REPLIES)
      const goal = rng.pick([`Reply "${text}" to ${post.fullName}'s message "${short(post.message)}" in ${post.ch[2]}.`,
        `In ${post.ch[2]}, answer the thread about "${short(post.message)}" with: ${text}`])
      return {
        goal, start: chanStart(post.ch), answer: `Replied in the thread of ${post.fullName}'s message.`,
        plan: [{ title: `Open the replies of ${post.fullName}'s message`, check: 'the thread panel is shown' },
          { title: 'Type the reply', check: `the reply box contains ${text}` }, { title: 'Press Enter to send the reply', check: `text "${text}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: /\d+ repl(y|ies)$/, inside: textRe(post.message), insideRole: 'listitem' }, settle: 1800 },
          { plan: 2, do: 'type', target: { role: 'textbox', name: /^Reply to this thread/ }, text },
          { plan: 3, do: 'press', key: 'Enter', settle: 1800 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from posts p join users u on u.id = p.userid where u.username = ${lit(ME)} and p.rootid = ${lit(post.id)} and p.message = ${lit(text)}`).length === 1,
      }
    },
    send_dm: async ({ rng, sh }) => {
      const rows = sql(sh, `select u.username, u.firstname || ' ' || u.lastname from channels c join channelmembers m on m.channelid = c.id join users u on u.id = m.userid
        where c.type = 'D' and c.name like '%' || ${lit('')} || '%' and c.id in (select channelid from channelmembers m2 join users me on me.id = m2.userid where me.username = ${lit(ME)}) and u.username <> ${lit(ME)}`)
      if (!rows.length) return null
      const [username, fullName] = rng.pick(rows)
      const text = newMessage(rng)
      return {
        goal: rng.pick([`Send ${fullName} a direct message: ${text}`, `DM ${fullName.split(' ')[0]} "${text}".`, `Message ${fullName} privately saying "${text}"`]),
        start: '/orbit/channels/town-square', answer: `Sent the direct message to ${fullName}.`,
        plan: [{ title: `Open the direct message with ${fullName}`, check: `heading or header shows ${fullName}` },
          { title: 'Type the message', check: `the message box contains ${text}` }, { title: 'Press Enter to send', check: `text "${text}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'link', name: new RegExp(`^${esc(fullName)}\\b`, 'i') }, settle: 1800 },
          { plan: 2, do: 'type', target: { role: 'textbox', name: new RegExp(`^Write to ${esc(fullName)}`, 'i') }, text },
          { plan: 3, do: 'press', key: 'Enter', settle: 1800 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from posts p join users u on u.id = p.userid join channels c on c.id = p.channelid join users o on c.name like '%' || o.id || '%'
          where u.username = ${lit(ME)} and o.username = ${lit(username)} and c.type = 'D' and p.message = ${lit(text)}`).length === 1,
      }
    },
    react: async ({ rng, sh }) => {
      let post = null
      for (let t = 0; t < 6 && !post; t++) post = recentPost(sh, rng, { withReactions: true })
      if (!post) return null
      const mine = sql(sh, `select emojiname from reactions r join users u on u.id = r.userid where r.postid = ${lit(post.id)} and u.username = ${lit(ME)} and r.deleteat = 0`).map((r) => r[0])
      const other = sql(sh, `select emojiname from reactions where postid = ${lit(post.id)} and deleteat = 0`).map((r) => r[0]).filter((e) => !mine.includes(e))
      if (!other.length) return null
      const emoji = rng.pick(other)
      return {
        goal: rng.pick([`Add a :${emoji}: reaction to ${post.fullName}'s message "${short(post.message)}" in ${post.ch[2]}.`, `React with :${emoji}: to the message "${short(post.message)}" in ${post.ch[2]}.`]),
        start: chanStart(post.ch), answer: `Reacted with :${emoji}:.`,
        plan: [{ title: `Click the :${emoji}: reaction under the message`, check: 'the reaction count goes up' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'button', name: new RegExp(`reacted with :${esc(emoji)}:`), inside: textRe(post.message), insideRole: 'listitem' }, settle: 1500 }],
        verify: async ({ sh }) => sql(sh, `select 1 from reactions r join users u on u.id = r.userid where r.postid = ${lit(post.id)} and u.username = ${lit(ME)} and r.emojiname = ${lit(emoji)} and r.deleteat = 0`).length === 1,
      }
    },
    custom_status: async ({ rng }) => {
      const suggested = [['In a meeting', ':calendar: In a meeting 1 hour'], ['Out for lunch', ':hamburger: Out for lunch 30 minutes'], ['Working from home', ':house: Working from home Today'], ['On a vacation', ':palm_tree: On a vacation This week'], ['Out sick', ':sneezing_face: Out sick Today']]
      const own = ['At the Pune office today', 'Focus time, slow replies', 'Travelling to Bengaluru', 'In interviews all afternoon', 'On call this week', 'Back after 3 PM']
      const pickSuggested = rng.chance(0.5)
      const [text, button] = pickSuggested ? rng.pick(suggested) : [rng.pick(own), null]
      const steps = [{ plan: 1, do: 'click', target: { role: 'button', name: "User's account menu" } },
        { plan: 1, do: 'click', target: { role: 'menuitem', name: 'Set custom status' }, settle: 1500 },
        pickSuggested ? { plan: 2, do: 'click', target: { role: 'button', name: button } } : { plan: 2, do: 'type', target: { role: 'textbox', name: 'Set a status' }, text },
        { plan: 3, do: 'click', target: { role: 'button', name: 'Set Status' }, settle: 1500 }]
      return {
        goal: rng.pick([`Set my custom status to "${text}".`, `Change your chat status message to ${text}.`, `Let people know I am "${text}" with a custom status.`]),
        start: rng.pick(['/orbit/channels/town-square', '/monsoon/channels/town-square', '/orbit/channels/engineering']), answer: `Custom status set to "${text}".`,
        plan: [{ title: 'Open the account menu and choose Set custom status', check: 'dialog "Set a status"' }, { title: pickSuggested ? `Pick "${text}"` : `Type "${text}"`, check: `textbox "Set a status" = ${text}` }, { title: 'Click Set Status', check: 'the dialog closes' }],
        steps,
        verify: async ({ sh }) => (sql(sh, `select props->>'customStatus' from users where username = ${lit(ME)}`)[0]?.[0] ?? '').includes(`"text":"${text}"`),
      }
    },
    pin_message: async ({ rng, sh }) => {
      let post = null
      for (let t = 0; t < 6 && !post; t++) {
        post = recentPost(sh, rng)
        if (post && sql(sh, `select 1 from posts where id = ${lit(post.id)} and ispinned`).length) post = null
      }
      if (!post) return null
      return {
        goal: rng.pick([`Pin ${post.fullName}'s message "${short(post.message)}" in ${post.ch[2]}.`, `In ${post.ch[2]}, pin the message "${short(post.message)}" to the channel.`]),
        start: chanStart(post.ch), answer: 'Pinned the message to the channel.',
        plan: [{ title: 'Point at the message to show its actions', check: 'button "more" is shown on the message' }, { title: 'Open More actions', check: 'menuitem "Pin to Channel"' }, { title: 'Click Pin to Channel', check: 'text "Pinned"' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'paragraph', text: textRe(post.message) } },
          { plan: 2, do: 'click', target: { role: 'button', name: 'more', inside: textRe(post.message), insideRole: 'listitem' } },
          { plan: 3, do: 'click', target: { role: 'menuitem', name: /^Pin to Channel/ }, settle: 1500 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from posts where id = ${lit(post.id)} and ispinned`).length === 1,
      }
    },
    save_message: async ({ rng, sh }) => {
      const post = recentPost(sh, rng)
      if (!post) return null
      return {
        goal: rng.pick([`Save the message "${short(post.message)}" from ${post.fullName} for later.`, `Bookmark ${post.fullName}'s message about "${short(post.message)}" in ${post.ch[2]}.`]),
        start: chanStart(post.ch), answer: 'Saved the message.',
        plan: [{ title: 'Point at the message to show its actions', check: 'button "save message" is shown' }, { title: 'Click save message', check: 'text "Saved"' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'paragraph', text: textRe(post.message) } },
          { plan: 2, do: 'click', target: { role: 'button', name: 'save message', inside: textRe(post.message), insideRole: 'listitem' }, settle: 1500 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from preferences p join users u on u.id = p.userid where u.username = ${lit(ME)} and p.category = 'flagged_post' and p.name = ${lit(post.id)}`).length === 1,
      }
    },
    react_new: async ({ rng, sh }) => {
      const post = recentPost(sh, rng)
      if (!post) return null
      const [label, emoji] = rng.pick([['+1', '+1'], ['grinning', 'grinning'], ['white check mark', 'white_check_mark']])
      if (sql(sh, `select 1 from reactions r join users u on u.id = r.userid where r.postid = ${lit(post.id)} and u.username = ${lit(ME)} and r.emojiname = ${lit(emoji)} and r.deleteat = 0`).length) return null
      return {
        goal: rng.pick([`React to "${short(post.message)}" with :${emoji}:.`, `Give ${post.fullName}'s message "${short(post.message)}" a :${emoji}: reaction.`]),
        start: chanStart(post.ch), answer: `Added :${emoji}: to the message.`,
        plan: [{ title: 'Point at the message to show its actions', check: `button "${label} emoji" is shown` }, { title: `Click the ${label} emoji`, check: `the :${emoji}: reaction shows under the message` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'paragraph', text: textRe(post.message) } },
          { plan: 2, do: 'click', target: { role: 'button', name: `${label} emoji`, inside: textRe(post.message), insideRole: 'listitem' }, settle: 1500 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from reactions r join users u on u.id = r.userid where r.postid = ${lit(post.id)} and u.username = ${lit(ME)} and r.emojiname = ${lit(emoji)} and r.deleteat = 0`).length === 1,
      }
    },
    edit_message: async ({ rng, sh }) => {
      const post = recentPost(sh, rng, { mine: true })
      if (!post) return null
      const text = newMessage(rng)
      return {
        goal: rng.pick([`Edit my message "${short(post.message)}" in ${post.ch[2]} so it says "${text}".`, `Change your post "${short(post.message)}" to: ${text}`]),
        start: chanStart(post.ch), answer: 'Edited the message.',
        plan: [{ title: 'Point at my message to show its actions', check: 'button "more" is shown' }, { title: 'Open More actions and choose Edit', check: 'the edit box is shown' },
          { title: 'Replace the text', check: `the edit box contains ${text}` }, { title: 'Press Enter to save', check: `text "${text}"` }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'paragraph', text: textRe(post.message) } },
          { plan: 2, do: 'click', target: { role: 'button', name: 'more', inside: textRe(post.message), insideRole: 'listitem' } },
          { plan: 2, do: 'click', target: { role: 'menuitem', name: /^Edit/ } },
          { plan: 3, do: 'type', target: { role: 'textbox', name: /edit/i }, text },
          { plan: 4, do: 'press', key: 'Enter', settle: 1500 },
        ],
        verify: async ({ sh }) => sql(sh, `select 1 from posts where id = ${lit(post.id)} and message = ${lit(text)}`).length === 1,
      }
    },
    create_channel: async ({ rng }) => {
      const team = rng.pick([['orbit', 'Orbit Labs'], ['monsoon', 'Monsoon Retail']])
      const name = `${rng.pick(['Atlas', 'Nimbus', 'Kestrel', 'Lotus', 'Orion', 'Q4', 'Diwali', 'Offsite', 'Vendor', 'Pune', 'Mobile', 'Design'])} ${rng.pick(['launch', 'planning', 'war room', 'feedback', 'standup', 'review', 'hiring', 'ops'])}`
      const priv = rng.chance(0.4)
      const steps = [{ plan: 1, do: 'click', target: { role: 'button', name: 'Browse or create channels' } },
        { plan: 1, do: 'click', target: { role: 'menuitem', name: /Create new channel/ }, settle: 1500 },
        { plan: 2, do: 'type', target: { role: 'textbox', name: /channel name/i }, text: name }]
      if (priv) steps.push({ plan: 2, do: 'click', target: { role: 'button', name: /Private Channel/ } })
      steps.push({ plan: 3, do: 'click', target: { role: 'button', name: /^Create channel/i }, settle: 2000 })
      return {
        goal: rng.pick([`Create a ${priv ? 'private' : 'public'} channel called "${name}" in ${team[1]}.`, `Make a new ${priv ? 'private ' : ''}channel named ${name}.`]),
        start: `/${team[0]}/channels/town-square`, answer: `Created the channel ${name}.`,
        plan: [{ title: 'Open Browse or create channels and choose Create new channel', check: 'the new channel dialog is shown' },
          { title: `Name it ${name}${priv ? ' and make it private' : ''}`, check: `textbox "Channel name" = ${name}` }, { title: 'Click Create channel', check: `heading or header "${name}"` }],
        steps,
        verify: async ({ sh }) => sql(sh, `select 1 from channels c join teams t on t.id = c.teamid where t.name = ${lit(team[0])} and c.displayname = ${lit(name)} and c.type = ${lit(priv ? 'P' : 'O')} and c.deleteat = 0`).length === 1,
      }
    },
    mute_channel: async ({ rng, sh }) => {
      const ch = rng.pick(myChannels(sh))
      return {
        goal: rng.pick([`Mute the ${ch[2]} channel.`, `Stop notifications from ~${ch[1]} by muting it.`]),
        start: chanStart(ch), answer: `${ch[2]} is muted.`,
        plan: [{ title: 'Open the channel menu in the header', check: 'menuitem "Mute Channel"' }, { title: 'Click Mute Channel', check: 'the channel shows as muted' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: new RegExp(`^${ch[2].split(/[- ]/).map(esc).join('[- ]')} channel menu$`, 'i') } },
          { plan: 2, do: 'click', target: { role: 'menuitem', name: /^Mute Channel/ }, settle: 1500 },
        ],
        verify: async ({ sh }) => sql(sh, `select m.notifyprops->>'mark_unread' from channelmembers m join users u on u.id = m.userid where u.username = ${lit(ME)} and m.channelid = ${lit(ch[3])}`)[0]?.[0] === 'mention',
      }
    },
    read_fact: async ({ rng, sh }) => {
      const words = ['Atlas', 'Nimbus', 'Kestrel', 'Lotus', 'Orion', 'Saffron', 'Tidal', 'Monarch', 'Zephyr', 'Banyan', 'Grafana', 'Sentry', 'Postgres', 'Redis', 'CDN',
        'Northwind', 'Bluefin', 'Greenleaf', 'Pixelforge', 'Skyroute', 'Acme', 'Brightdesk', 'Pune', 'Kochi', 'Indore', 'Jaipur', 'Goa', 'Chennai']
      const team = rng.pick(['orbit', 'monsoon'])
      const rows = sql(sh, `select p.id, p.message, u.username, u.firstname || ' ' || u.lastname, c.displayname from posts p join users u on u.id = p.userid join channels c on c.id = p.channelid
        join teams t on t.id = c.teamid join channelmembers m on m.channelid = c.id and m.userid = (select id from users where username = ${lit(ME)})
        where t.name = ${lit(team)} and c.type in ('O','P') and p.type = '' and p.rootid = '' and p.deleteat = 0 and u.username <> 'farmadmin' order by random() limit 60`)
      for (const [, message, username, fullName, chName] of rows) {
        const word = words.find((w) => message.includes(w))
        if (!word) continue
        // One message only from that person about that word, so the answer is unambiguous.
        const same = sql(sh, `select count(*) from posts p join channels c on c.id = p.channelid join teams t on t.id = c.teamid join users u on u.id = p.userid
          where t.name = ${lit(team)} and u.username = ${lit(username)} and p.message like ${lit(`%${word}%`)} and p.deleteat = 0`)[0][0]
        if (same !== '1') continue
        const query = `from:${username} ${word}`
        return {
          goal: rng.pick([`What did ${fullName} say about ${word}?`, `Find what ${fullName.split(' ')[0]} wrote about ${word} in ${team === 'orbit' ? 'Orbit Labs' : 'Monsoon Retail'}.`, `Look up ${fullName}'s message about ${word} and tell me what it says.`]),
          start: `/${team}/channels/town-square`, answer: `${fullName} wrote in ${chName}: "${message}"`,
          plan: [{ title: 'Open the search box', check: 'the search box is active' }, { title: `Search for ${query}`, check: `the search box contains ${query}` }, { title: 'Press Enter and read the result', check: `text "${message.slice(0, 40)}"` }],
          steps: [
            { plan: 1, do: 'click', target: { role: 'button', name: /Search$/, under: /banner/ } },
            { plan: 2, do: 'type', target: { role: 'searchbox', name: 'Search messages' }, text: query },
            { plan: 3, do: 'press', key: 'Enter', settle: 2500 },
          ],
          verify: async ({ snapshot }) => snapshot.includes(message.slice(0, 40)),
          writes: false,
        }
      }
      return null
    },
    favorite_channel: async ({ rng, sh }) => {
      const id = meId(sh)
      const favs = sql(sh, `select name from preferences where userid = ${lit(id)} and category = 'favorite_channel' and value = 'true'`).map((r) => r[0])
      const ch = rng.pick(myChannels(sh).filter((c) => !favs.includes(c[3])))
      return {
        goal: rng.pick([`Add the ${ch[2]} channel to my favorites.`, `Mark ~${ch[1]} as a favorite channel.`, `Star the ${ch[2]} channel.`]),
        start: chanStart(ch), answer: `${ch[2]} is now a favorite.`,
        plan: [{ title: 'Click "add to favorites" in the channel header', check: 'button "remove from favorites"' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'button', name: 'add to favorites' }, settle: 1500 }],
        verify: async ({ sh }) => sql(sh, `select 1 from preferences where userid = ${lit(id)} and category = 'favorite_channel' and name = ${lit(ch[3])} and value = 'true'`).length === 1,
      }
    },
    search: async ({ rng, sh }) => {
      const team = rng.pick(['orbit', 'monsoon'])
      const count = (w) => Number(sql(sh, `select count(*) from posts p join channels c on c.id = p.channelid join teams t on t.id = c.teamid
        join channelmembers m on m.channelid = c.id join users u on u.id = m.userid where u.username = ${lit(ME)} and t.name = ${lit(team)} and p.message ilike ${lit(`%${w}%`)} and p.deleteat = 0`)[0][0])
      const word = rng.shuffle(['Kestrel', 'Atlas', 'Nimbus', 'Orion', 'Saffron', 'Tidal', 'Monarch', 'Zephyr', 'Banyan', 'Lotus', 'Grafana', 'Sentry', 'invoice', 'shipment', 'rollout', 'Diwali', 'warehouse', 'postmortem', 'payroll', 'campaign', 'escalation', 'refund', 'Figma', 'mockups'])
        .find((w) => count(w) > 0)
      if (!word) return null
      return {
        goal: rng.pick([`Search the chat for messages about ${word}.`, `Find messages that mention "${word}".`, `Look up ${word} in the message search.`]),
        start: `/${team}/channels/town-square`, answer: `Showing the search results for "${word}".`,
        plan: [{ title: 'Open the search box', check: 'the search box is active' }, { title: `Type ${word}`, check: `the search box contains ${word}` }, { title: 'Press Enter', check: 'text "Search results"' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: /Search$/, under: /banner/ } },
          { plan: 2, do: 'type', target: { role: 'searchbox', name: 'Search messages' }, text: word },
          { plan: 3, do: 'press', key: 'Enter', settle: 2500 },
        ],
        verify: async ({ snapshot }) => /Search results|Search Results/i.test(snapshot) && new RegExp(esc(word), 'i').test(snapshot),
        writes: false,
      }
    },
  },
}
