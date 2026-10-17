// HumHub 1.18 on people.farm.test: LinkedIn/Facebook-like social intranet (profiles with job titles,
// spaces, posts, comments, likes, follows, friend requests). HELD-OUT TEST APP: output only to
// /workspace/action-data/clones-test-humhub/. State checks read HumHub's MariaDB.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { esc, head, sql, sqlStr, statusText, replyText, BIOS } from './social-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
const ORIGIN = 'http://people.farm.test'
export const ME = 'asha_rao'
const POST = 'humhub\\\\modules\\\\post\\\\models\\\\Post'
const USER = 'humhub\\\\modules\\\\user\\\\models\\\\User'
const SPACE = 'humhub\\\\modules\\\\space\\\\models\\\\Space'

const db = (sh, q) => sql(sh, 'humhub', q, 'mysql')
const meId = (sh) => db(sh, `select id from user where username = '${ME}'`)[0][0]
const people = (sh) => db(sh, `select u.id, u.username, concat(p.firstname, ' ', p.lastname), p.title, p.city from user u join profile p on p.user_id = u.id where u.username not in ('${ME}', 'farmadmin') and u.status = 1`).map(([id, nick, name, title, city]) => ({ id, nick, name, title, city }))
const spaces = (sh) => db(sh, `select s.id, s.url, s.name, exists(select 1 from space_membership m where m.space_id = s.id and m.user_id = ${meId(sh)} and m.status = 3) from space s order by s.id`).map(([id, url, name, member]) => ({ id, url, name, member: member === '1' }))
/** Newest posts in a space stream (unique texts), with author, like and comment counts. */
function spacePosts(sh, s, n = 3) {
  const rows = db(sh, `select p.id, p.message, concat(pr.firstname, ' ', pr.lastname), (select count(*) from \`like\` l where l.object_model = '${POST}' and l.object_id = p.id),
      (select count(*) from comment m where m.object_model = '${POST}' and m.object_id = p.id), exists(select 1 from \`like\` l where l.object_model = '${POST}' and l.object_id = p.id and l.created_by = ${meId(sh)})
    from post p join content c on c.object_model = '${POST}' and c.object_id = p.id join contentcontainer cc on cc.id = c.contentcontainer_id
      join profile pr on pr.user_id = c.created_by
    where cc.class = '${SPACE}' and cc.pk = ${s.id} and c.state = 1 order by c.stream_sort_date desc limit ${n}`)
    .map(([id, text, author, likes, comments, liked]) => ({ id, text, author, likes: Number(likes), comments: Number(comments), liked: liked === '1' }))
  return rows.filter((p) => rows.filter((o) => o.text === p.text).length === 1)
}
const quote = (p) => `"${head(p.text, 7)}${p.text.split(/\s+/).length > 7 ? '…' : ''}"`
/** A post-level control (Like, "(n)") on a stream: its 4 nearest ancestors include the post body, which starts with the text. */
const onPost = (p) => ({ inside: new RegExp(`^${esc(p.text)}`), insideDepth: 4 })
const following = (sh) => new Set(db(sh, `select object_id from user_follow where object_model = '${USER}' and user_id = ${meId(sh)}`).map((r) => r[0]))
const friendState = (sh, other) => {
  const me = meId(sh)
  const a = db(sh, `select count(*) from user_friendship where user_id = ${me} and friend_user_id = ${other}`)[0][0] === '1'
  const b = db(sh, `select count(*) from user_friendship where user_id = ${other} and friend_user_id = ${me}`)[0][0] === '1'
  return a && b ? 'friends' : a ? 'sent' : b ? 'received' : 'none'
}
const composeSteps = (text, submitPlan) => [
  { plan: 1, do: 'click', target: { role: 'paragraph', text: /^What's on your mind\?$/ } },
  { plan: 1, do: 'type', target: { role: 'paragraph', text: /^(What's on your mind\?)?$/, nth: 0, only: true }, text },
  { plan: submitPlan, do: 'click', target: { role: 'button', name: 'Submit' }, settle: 2500 }
]

export default {
  name: 'humhub',
  family: 'people',
  origin: ORIGIN,
  portOffset: 42,
  explorePaths: ['/dashboard', '/people', '/spaces', '/u/asha_rao/', '/friendship/manage', '/user/account/edit'],
  async reset({ sh }) { sh('bash /workspace/action-data-gen/scripts/clones/farm/humhub/reset.sh') },
  async login({ page, sleep }) {
    await page.context().clearCookies()
    await page.goto(`${ORIGIN}/user/auth/login`)
    await page.fill('#login_username', ME)
    await page.fill('#login_password', ACCOUNTS.password)
    await Promise.all([page.waitForURL((u) => !String(u).includes('/login'), { timeout: 30_000 }), page.click('#login-button')])
    await sleep(1000)
  },
  tasks: {
    post_in_space: async ({ rng, sh }) => {
      const s = rng.pick(spaces(sh).filter((x) => x.member))
      if (!s) return null
      const text = statusText(rng, { tags: false })
      return {
        goal: rng.pick([`Post "${text}" in the ${s.name} space.`, `Share an update in ${s.name}: ${text}`, `Write a post to the ${s.name} space saying "${text}".`]),
        start: `/s/${s.url}/`,
        plan: [{ title: 'Write the post in "What\'s on your mind?"', check: `the editor shows "${head(text, 4)}"` }, { title: 'Click Submit', check: 'the post appears at the top of the stream' }],
        steps: composeSteps(text, 2),
        answer: `Posted in ${s.name}.`,
        verify: async ({ sh }) => db(sh, `select count(*) from post p join content c on c.object_model = '${POST}' and c.object_id = p.id join contentcontainer cc on cc.id = c.contentcontainer_id where cc.class = '${SPACE}' and cc.pk = ${s.id} and c.created_by = ${meId(sh)} and c.created_at > now() - interval 30 minute and p.message like ${sqlStr(`%${head(text, 4)}%`)}`)[0][0] !== '0'
      }
    },
    post_status: async ({ rng }) => {
      const text = statusText(rng, { tags: false })
      return {
        goal: rng.pick([`Post a status update on my profile: "${text}"`, `Share "${text}" on my own profile stream.`, `Update my profile with a post that says: ${text}`]),
        start: `/u/${ME}/`,
        plan: [{ title: 'Write the post in "What\'s on your mind?"', check: `the editor shows "${head(text, 4)}"` }, { title: 'Click Submit', check: 'the post appears on my profile' }],
        steps: composeSteps(text, 2),
        answer: 'Posted the update on my profile.',
        verify: async ({ sh }) => db(sh, `select count(*) from post p join content c on c.object_model = '${POST}' and c.object_id = p.id join contentcontainer cc on cc.id = c.contentcontainer_id where cc.class = '${USER}' and cc.pk = ${meId(sh)} and c.created_at > now() - interval 30 minute and p.message like ${sqlStr(`%${head(text, 4)}%`)}`)[0][0] !== '0'
      }
    },
    comment_post: async ({ rng, sh }) => {
      const s = rng.pick(spaces(sh).filter((x) => x.member))
      const p = rng.pick(spacePosts(sh, s, 6))
      if (!p) return null
      const text = replyText(rng)
      return {
        goal: rng.pick([`Comment "${text}" on ${p.author}'s post ${quote(p)}.`, `Reply to ${p.author}'s post in ${s.name} with: ${text}`, `Leave a comment on the post ${quote(p)}: "${text}"`]),
        start: `/s/${s.url}/post/post/view?id=${p.id}`,
        plan: [{ title: 'Click "Write a new comment..."', check: 'the comment editor is active' }, { title: 'Type the comment', check: `the editor shows "${head(text, 3)}"` }, { title: 'Click the send button', check: 'the comment appears under the post' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'paragraph', text: /^Write a new comment/ } },
          { plan: 2, do: 'type', target: { role: 'paragraph', text: /^(Write a new comment\.\.\.)?$/, nth: 0, only: true }, text },
          { plan: 3, do: 'click', target: { role: 'button', name: '', inside: /Attach Files/, insideDepth: 2 }, settle: 2000 }
        ],
        answer: `Commented "${text}".`,
        verify: async ({ sh }) => db(sh, `select count(*) from comment where object_model = '${POST}' and object_id = ${p.id} and created_by = ${meId(sh)} and created_at > now() - interval 30 minute and message like ${sqlStr(`%${head(text, 2)}%`)}`)[0][0] !== '0'
      }
    },
    like_post: async ({ rng, sh }) => {
      const s = rng.pick(spaces(sh))
      const p = rng.pick(spacePosts(sh, s).filter((x) => !x.liked))
      if (!p) return null
      return {
        goal: rng.pick([`Like ${p.author}'s post ${quote(p)} in ${s.name}.`, `In the ${s.name} space, like the post ${quote(p)}.`, `Give a like to ${p.author}'s latest update in ${s.name}: ${quote(p)}.`]),
        start: `/s/${s.url}/`,
        plan: [{ title: `Click Like under ${p.author}'s post`, check: 'the link changes to Unlike' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'link', name: 'Like', ...onPost(p) } }],
        answer: `Liked ${p.author}'s post.`,
        verify: async ({ sh }) => db(sh, `select count(*) from \`like\` where object_model = '${POST}' and object_id = ${p.id} and created_by = ${meId(sh)}`)[0][0] === '1'
      }
    },
    read_likes: async ({ rng, sh }) => {
      const s = rng.pick(spaces(sh))
      const p = rng.pick(spacePosts(sh, s).filter((x) => x.likes > 0))
      if (!p) return null
      return {
        goal: rng.pick([`Who liked ${p.author}'s post ${quote(p)} in ${s.name}? How many likes does it have?`, `How many people liked the post ${quote(p)} in ${s.name}?`]),
        start: `/s/${s.url}/`, writes: false,
        plan: [{ title: 'Open the list of likes under the post', check: 'a dialog lists the people who liked it' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'link', name: `(${p.likes})`, ...onPost(p) }, settle: 2000 }],
        answer: `${p.likes} like${p.likes === 1 ? '' : 's'}.`,
        verify: async ({ sh }) => spacePosts(sh, s, 10).find((x) => x.id === p.id)?.likes === p.likes
      }
    },
    follow_user: async ({ rng, sh }) => {
      const f = following(sh)
      const u = rng.pick(people(sh).filter((x) => !f.has(x.id)))
      if (!u) return null
      return {
        goal: rng.pick([`Follow ${u.name}.`, `Find ${u.name} in the People directory and follow them.`, `I want ${u.name}'s updates (${u.title}). Follow them.`]),
        start: '/people',
        plan: [{ title: `Search the people directory for ${u.name}`, check: `textbox "Search..." = ${u.name}` }, { title: 'Run the search', check: `${u.name} is listed` }, { title: `Click Follow on ${u.name}'s card`, check: 'the button shows Following' }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Search...' }, text: u.name },
          { plan: 2, do: 'press', key: 'Enter', settle: 2500 },
          { plan: 3, do: 'click', target: { role: 'link', name: 'Follow', inside: new RegExp(esc(u.name)), insideDepth: 4 } }
        ],
        answer: `Following ${u.name}.`,
        verify: async ({ sh }) => following(sh).has(u.id)
      }
    },
    unfollow_user: async ({ rng, sh }) => {
      const f = following(sh)
      const u = rng.pick(people(sh).filter((x) => f.has(x.id) && friendState(sh, x.id) === 'none'))
      if (!u) return null
      return {
        goal: rng.pick([`Unfollow ${u.name}.`, `Stop following ${u.name}.`]),
        start: `/u/${u.nick}/`,
        plan: [{ title: 'Open the profile actions menu (gear)', check: 'the menu shows Following' }, { title: 'Click Following', check: 'a confirm dialog' }, { title: 'Click Confirm', check: 'I no longer follow them' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: '', inside: /^Friends|^Add Friend|Friendship|Following/, insideDepth: 2 } },
          { plan: 2, do: 'click', target: { role: 'link', name: 'Following' } },
          { plan: 3, do: 'click', target: { role: 'button', name: 'Confirm' }, settle: 2000 }
        ],
        answer: `Unfollowed ${u.name}.`,
        verify: async ({ sh }) => !following(sh).has(u.id)
      }
    },
    accept_request: async ({ rng, sh }) => {
      const u = rng.pick(people(sh).filter((x) => friendState(sh, x.id) === 'received'))
      if (!u) return null
      const fromProfile = rng.chance(0.4)
      return {
        goal: rng.pick([`Accept the connection request from ${u.name}.`, `${u.name} sent me a friend request. Accept it.`, `Approve ${u.name}'s friend request.`]),
        start: fromProfile ? `/u/${u.nick}/` : '/friendship/manage/requests',
        plan: fromProfile ? [{ title: 'Click Accept Friend Request', check: 'a confirm dialog' }, { title: 'Click Confirm', check: `${u.name} is a friend` }] : [{ title: `Click Accept for ${u.name}`, check: `${u.name} is a friend` }],
        steps: fromProfile
          ? [{ plan: 1, do: 'click', target: { role: 'link', name: 'Accept Friend Request' } }, { plan: 2, do: 'click', target: { role: 'button', name: 'Confirm' }, settle: 2000 }]
          : [{ plan: 1, do: 'click', target: { role: 'link', name: 'Accept', inside: new RegExp(esc(u.name)), insideRole: 'row' }, settle: 2000 }],
        answer: `Accepted ${u.name}'s request.`,
        verify: async ({ sh }) => friendState(sh, u.id) === 'friends'
      }
    },
    add_friend: async ({ rng, sh }) => {
      const u = rng.pick(people(sh).filter((x) => friendState(sh, x.id) === 'none'))
      if (!u) return null
      return {
        goal: rng.pick([`Send a friend request to ${u.name}.`, `Connect with ${u.name} (${u.title}).`, `Add ${u.name} as a friend.`]),
        start: `/u/${u.nick}/`,
        plan: [{ title: 'Click the "+ Friends" button on the profile', check: 'a confirm dialog' }, { title: 'Click Confirm', check: 'the request is sent' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'link', name: 'Friends', inside: /Block user|Following/, insideDepth: 2 } },
          { plan: 2, do: 'click', target: { role: 'button', name: 'Confirm' }, settle: 2000 }
        ],
        answer: `Friend request sent to ${u.name}.`,
        verify: async ({ sh }) => friendState(sh, u.id) === 'sent'
      }
    },
    join_space: async ({ rng, sh }) => {
      const s = rng.pick(spaces(sh).filter((x) => !x.member))
      if (!s) return null
      const fromList = rng.chance(0.5)
      return {
        goal: rng.pick([`Join the ${s.name} space.`, `Become a member of ${s.name}.`, `I want to take part in ${s.name}. Join it.`]),
        start: fromList ? '/spaces' : `/s/${s.url}/`,
        plan: fromList ? [{ title: `Open ${s.name} from the spaces directory`, check: `heading "${s.name}"` }, { title: 'Click Join', check: 'I am a member' }] : [{ title: 'Click Join', check: 'I am a member' }],
        steps: fromList
          ? [{ plan: 1, do: 'click', target: { role: 'link', name: new RegExp(`^${esc(s.name)}`), nth: 0, only: true }, settle: 2000 }, { plan: 2, do: 'click', target: { role: 'link', name: 'Join' }, settle: 2000 }]
          : [{ plan: 1, do: 'click', target: { role: 'link', name: 'Join' }, settle: 2000 }],
        answer: `Joined ${s.name}.`,
        verify: async ({ sh }) => spaces(sh).find((x) => x.id === s.id).member
      }
    },
    edit_profile: async ({ rng, sh }) => {
      const field = rng.pick(['Title', 'About', 'City'])
      const value = { Title: rng.pick(['Senior Product Manager at Northwind Labs', 'Head of Data at Lotus Bank', 'Engineering Manager at Kite Mobility', 'Staff Designer at Pixelforge']), About: rng.pick(BIOS), City: rng.pick(['Pune', 'Bengaluru', 'Chennai', 'Lisbon', 'Kochi']) }[field]
      const col = field.toLowerCase()
      if (db(sh, `select ${col} from profile where user_id = ${meId(sh)}`)[0]?.[0] === value) return null
      return {
        goal: rng.pick([`Change my ${field.toLowerCase()} to "${value}".`, `Update my profile: ${field.toLowerCase()} should be ${value}.`, `Edit my profile and set the ${field} field to "${value}".`]),
        start: '/user/account/edit',
        plan: [{ title: `Replace the ${field}`, check: `textbox "${field}" = ${value}` }, { title: 'Click Save profile', check: 'the profile is saved' }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: field }, text: value },
          { plan: 2, do: 'click', target: { role: 'button', name: 'Save profile' }, settle: 2000 }
        ],
        answer: `${field} updated.`,
        verify: async ({ sh }) => db(sh, `select ${col} from profile where user_id = ${meId(sh)}`)[0]?.[0] === value
      }
    },
    read_profile: async ({ rng, sh }) => {
      const u = rng.pick(people(sh))
      const what = rng.pick(['title', 'city'])
      return {
        goal: what === 'title' ? rng.pick([`What is ${u.name}'s job title?`, `Where does ${u.name} work and in what role?`]) : `Which city is ${u.name} in, according to their profile?`,
        start: '/people', writes: false,
        plan: [{ title: `Search for ${u.name}`, check: `textbox "Search..." = ${u.name}` }, { title: 'Run the search', check: `${u.name} is listed` }, { title: `Open ${u.name}'s profile`, check: `heading "${u.name}"` }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Search...' }, text: u.name },
          { plan: 2, do: 'press', key: 'Enter', settle: 2500 },
          { plan: 3, do: 'click', target: { role: 'link', name: u.name, nth: 0, only: true }, settle: 2500 }
        ],
        answer: what === 'title' ? `${u.name}: ${u.title}.` : `${u.name} is in ${u.city}.`,
        verify: async ({ sh }) => people(sh).find((x) => x.id === u.id)?.[what] === u[what]
      }
    },
    delete_post: async ({ rng, sh }) => {
      const mine = db(sh, `select p.id, p.message, cc.class, cc.pk from post p join content c on c.object_model = '${POST}' and c.object_id = p.id join contentcontainer cc on cc.id = c.contentcontainer_id where c.created_by = ${meId(sh)} and c.state = 1 order by c.id desc limit 8`)
      if (!mine.length) return null
      const [id, text, cls, pk] = rng.pick(mine)
      const where = cls.endsWith('Space') ? `/s/${db(sh, `select url from space where id = ${pk}`)[0][0]}` : `/u/${ME}`
      const p = { text }
      return {
        goal: rng.pick([`Delete my post ${quote(p)}.`, `Remove the update where I wrote ${quote(p)}.`]),
        start: `${where}/post/post/view?id=${id}`,
        plan: [{ title: 'Open the post menu', check: 'the menu shows Delete' }, { title: 'Click Delete', check: 'a confirm dialog' }, { title: 'Confirm Delete', check: 'the post is gone' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'Toggle stream entry menu' } },
          { plan: 2, do: 'click', target: { role: 'link', name: /Delete/ } },
          { plan: 3, do: 'click', target: { role: 'button', name: 'Delete' }, settle: 2000 }
        ],
        answer: `Deleted the post ${quote(p)}.`,
        verify: async ({ sh }) => db(sh, `select count(*) from content where object_model = '${POST}' and object_id = ${id} and state = 1`)[0][0] === '0'
      }
    }
  }
}
