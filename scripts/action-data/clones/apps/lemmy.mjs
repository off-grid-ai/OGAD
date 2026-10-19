// Lemmy 0.19 + lemmy-ui on forum.farm.test: Reddit-like communities, posts, threaded comments, votes.
// State checks read Lemmy's own PostgreSQL DB.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { esc, head, sql, sqlStr, statusText, replyText, BIOS } from './social-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
const ORIGIN = 'http://forum.farm.test'
export const ME = 'asha_rao'

const db = (sh, q) => sql(sh, 'lemmy', q)
const meId = (sh) => db(sh, `select id from person where name = '${ME}' and local`)[0][0]
const communities = (sh) => db(sh, `select c.id, c.name, c.title, exists(select 1 from community_follower f join person p on p.id = f.person_id where f.community_id = c.id and p.name = '${ME}') from community c where not c.deleted order by c.id`).map(([id, name, title, sub]) => ({ id, name, title, sub: sub === 't' }))
/** The newest posts of a community, as /c/<name>?sort=New lists them (unique titles only). */
function newest(sh, c, n = 6) {
  const rows = db(sh, `select p.id, p.name, coalesce(pe.display_name, pe.name), pe.name, pa.comments, pa.score, pa.upvotes,
      coalesce((select score from post_like l where l.post_id = p.id and l.person_id = ${meId(sh)}), 0), exists(select 1 from post_saved s where s.post_id = p.id and s.person_id = ${meId(sh)})
    from post p join person pe on pe.id = p.creator_id join post_aggregates pa on pa.post_id = p.id
    where p.community_id = ${c.id} and not p.deleted and not p.removed order by p.published desc limit 20`)
    .map(([id, title, author, nick, comments, score, upvotes, myVote, saved]) => ({ id, title, author, nick, comments: Number(comments), score: Number(score), upvotes: Number(upvotes), myVote: Number(myVote), saved: saved === 't' }))
  return rows.filter((p) => rows.filter((o) => o.title === p.title).length === 1).slice(0, n)
}
const inPost = (p) => ({ inside: new RegExp(`(^|\\s)${esc(p.title)}\\s`), insideRole: 'article' })
const titleQ = (p) => `"${p.title}"`

function postTitle(rng) {
  return rng.pick(['Question about', 'Thoughts on', 'Tips for', 'My week with', 'Help with', 'Anyone tried', 'Small win:', 'Discussion:']) + ' ' +
    rng.pick(['weekend baking', 'a budget trip to Goa', 'learning Rust', 'the new metro line', 'monsoon running', 'home composting', 'a used film camera', 'reading more books', 'the IPL auction', 'remote standups', 'indie games on sale', 'a 5K training plan'])
}

const votePost = (dir) => async ({ rng, sh }) => {
  const c = rng.pick(communities(sh))
  const p = rng.pick(newest(sh, c).filter((x) => x.myVote === 0).slice(0, 4))
  if (!p) return null
  const verb = dir === 1 ? 'Upvote' : 'Downvote'
  return {
    goal: rng.pick([`${verb} the post ${titleQ(p)} in ${c.title}.`, `In the ${c.title} community, ${verb.toLowerCase()} ${titleQ(p)} by ${p.author}.`, `Go to c/${c.name} and ${verb.toLowerCase()} the post ${titleQ(p)}.`]),
    start: `/c/${c.name}?sort=New`,
    plan: [{ title: `Click ${verb} on ${titleQ(p)}`, check: `the ${verb.toLowerCase()} arrow is highlighted` }],
    steps: [{ plan: 1, do: 'click', target: { role: 'button', name: verb, ...inPost(p) } }],
    answer: `${verb}d ${titleQ(p)}.`,
    verify: async ({ sh }) => db(sh, `select score from post_like where post_id = ${p.id} and person_id = ${meId(sh)}`)[0]?.[0] === String(dir)
  }
}

export default {
  name: 'lemmy',
  family: 'forum',
  origin: ORIGIN,
  portOffset: 41,
  explorePaths: ['/', '/communities', '/c/technology', '/c/cricket', '/c/travel', '/u/asha_rao', '/search', '/inbox', '/settings'],
  async reset({ sh }) { sh('bash /workspace/action-data-gen/scripts/clones/farm/lemmy/reset.sh') },
  async login({ page, sleep }) {
    await page.context().clearCookies()
    await page.goto(`${ORIGIN}/login`)
    await page.fill('#login-email-or-username', ME)
    await page.fill('input[type=password]', ACCOUNTS.password)
    await Promise.all([page.waitForURL((u) => !String(u).includes('/login'), { timeout: 30_000 }), page.click('button.btn-secondary[type=submit]')])
    await sleep(1000)
  },
  tasks: {
    upvote_post: votePost(1),
    downvote_post: votePost(-1),
    save_post: async ({ rng, sh }) => {
      const c = rng.pick(communities(sh))
      const p = rng.pick(newest(sh, c).filter((x) => !x.saved).slice(0, 4))
      if (!p) return null
      return {
        goal: rng.pick([`Save the post ${titleQ(p)} from ${c.title} for later.`, `Bookmark ${titleQ(p)} in c/${c.name}.`]),
        start: `/c/${c.name}?sort=New`,
        plan: [{ title: `Click Save on ${titleQ(p)}`, check: 'the button changes to Unsave' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'button', name: 'Save', ...inPost(p) } }],
        answer: `Saved ${titleQ(p)}.`,
        verify: async ({ sh }) => db(sh, `select count(*) from post_saved where post_id = ${p.id} and person_id = ${meId(sh)}`)[0][0] === '1'
      }
    },
    comment_post: async ({ rng, sh }) => {
      const c = rng.pick(communities(sh))
      const p = rng.pick(newest(sh, c))
      if (!p) return null
      const text = rng.chance(0.5) ? replyText(rng) : statusText(rng, { tags: false })
      return {
        goal: rng.pick([`Comment "${text}" on the post ${titleQ(p)} in ${c.title}.`, `Leave a comment on ${titleQ(p)}: ${text}`, `Reply to ${p.author}'s post ${titleQ(p)} with "${text}".`]),
        start: `/post/${p.id}`,
        plan: [{ title: 'Type the comment', check: `textbox "Body" = ${text}` }, { title: 'Click Post', check: 'the comment appears under the post' }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Body', nth: 0, only: true }, text },
          { plan: 2, do: 'click', target: { role: 'button', name: 'Post' }, settle: 2000 }
        ],
        answer: `Commented "${text}".`,
        verify: async ({ sh }) => db(sh, `select count(*) from comment where post_id = ${p.id} and creator_id = ${meId(sh)} and content = ${sqlStr(text)}`)[0][0] === '1'
      }
    },
    reply_comment: async ({ rng, sh }) => {
      const c = rng.pick(communities(sh))
      const p = rng.pick(newest(sh, c).filter((x) => x.comments >= 2 && x.comments <= 12))
      if (!p) return null
      const rows = db(sh, `select cm.id, cm.content, coalesce(pe.display_name, pe.name) from comment cm join person pe on pe.id = cm.creator_id where cm.post_id = ${p.id} and not cm.deleted and nlevel(cm.path) = 2 and pe.name <> '${ME}'`)
      const cands = rows.filter(([, content, author]) => rows.filter((r) => r[1] === content && r[2] === author).length === 1)
      if (!cands.length) return null
      const [cid, content, author] = rng.pick(cands)
      const text = replyText(rng)
      return {
        goal: rng.pick([`On ${titleQ(p)}, reply to ${author}'s comment "${content}" with "${text}".`, `Answer ${author} ("${content}") under the post ${titleQ(p)}: ${text}`]),
        start: `/post/${p.id}`,
        plan: [{ title: `Click Reply on ${author}'s comment`, check: 'a reply box opens under the comment' }, { title: 'Type the reply', check: `the reply box shows "${head(text, 3)}"` }, { title: 'Click Reply to send it', check: 'the reply appears under the comment' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'Reply', inside: new RegExp(`${esc(author)}[\\s\\S]*${esc(content)}`), insideRole: 'article' } },
          { plan: 2, do: 'type', target: { role: 'textbox', name: 'Body', nth: 1, only: true }, text },
          { plan: 3, do: 'click', target: { role: 'button', name: 'Reply', inside: /Cancel/, insideDepth: 2 }, settle: 2000 }
        ],
        answer: `Replied "${text}" to ${author}.`,
        verify: async ({ sh }) => db(sh, `select count(*) from comment c join comment parent on parent.id = ${cid} where c.creator_id = ${meId(sh)} and c.content = ${sqlStr(text)} and subpath(c.path, 0, -1) = parent.path`)[0][0] === '1'
      }
    },
    create_post: async ({ rng, sh }) => {
      const c = rng.pick(communities(sh))
      const title = postTitle(rng)
      const body = statusText(rng, { tags: false })
      return {
        goal: rng.pick([`Create a post in ${c.title} titled "${title}" with the text "${body}".`, `Start a new thread in c/${c.name}: title "${title}", body "${body}".`, `Post "${title}" to the ${c.title} community. Body: ${body}`]),
        start: `/create_post?communityId=${c.id}`,
        plan: [{ title: 'Type the title', check: `textbox "Title" = ${title}` }, { title: 'Type the body', check: `textbox "Body" = ${body}` }, { title: 'Click Create', check: `heading "${title}"` }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Title' }, text: title },
          { plan: 2, do: 'type', target: { role: 'textbox', name: 'Body' }, text: body },
          { plan: 3, do: 'click', target: { role: 'button', name: 'Create' }, settle: 2500 }
        ],
        answer: `Posted "${title}" in ${c.title}.`,
        verify: async ({ sh }) => db(sh, `select count(*) from post where creator_id = ${meId(sh)} and community_id = ${c.id} and name = ${sqlStr(title)} and body = ${sqlStr(body)}`)[0][0] === '1'
      }
    },
    join_community: async ({ rng, sh }) => {
      const c = rng.pick(communities(sh).filter((x) => !x.sub))
      if (!c) return null
      const fromList = rng.chance(0.5)
      return {
        goal: rng.pick([`Join the ${c.title} community.`, `Subscribe to c/${c.name}.`, `I want ${c.title} posts in my feed. Subscribe to that community.`]),
        start: fromList ? '/communities' : `/c/${c.name}`,
        plan: fromList ? [{ title: `Click Subscribe in the ${c.title} row`, check: `the ${c.title} row shows Joined` }] : [{ title: 'Click Subscribe', check: 'the button shows Joined' }],
        steps: [{ plan: 1, do: 'click', target: fromList ? { role: 'button', name: 'Subscribe', inside: new RegExp(`^${esc(c.title)}\\b`), insideRole: 'row' } : { role: 'button', name: 'Subscribe' } }],
        answer: `Joined ${c.title}.`,
        verify: async ({ sh }) => communities(sh).find((x) => x.id === c.id).sub
      }
    },
    leave_community: async ({ rng, sh }) => {
      const c = rng.pick(communities(sh).filter((x) => x.sub))
      if (!c) return null
      return {
        goal: rng.pick([`Leave the ${c.title} community.`, `Unsubscribe from c/${c.name}.`]),
        start: `/c/${c.name}`,
        plan: [{ title: 'Click the Joined button to unsubscribe', check: 'the button shows Subscribe' }],
        steps: [{ plan: 1, do: 'click', target: { role: 'button', name: /^(Joined|Subscribed)$/ } }],
        answer: `Left ${c.title}.`,
        verify: async ({ sh }) => !communities(sh).find((x) => x.id === c.id).sub
      }
    },
    edit_bio: async ({ rng }) => {
      const bio = rng.pick(BIOS)
      return {
        goal: rng.pick([`Change my profile bio to "${bio}".`, `Update my bio on Threadly: ${bio}`, `Set my profile description to "${bio}" and save.`]),
        start: '/settings',
        plan: [{ title: 'Replace the bio text', check: `textbox "Body" = ${bio}` }, { title: 'Click Save', check: 'the settings are saved' }],
        steps: [
          { plan: 1, do: 'type', target: { role: 'textbox', name: 'Body' }, text: bio },
          { plan: 2, do: 'click', target: { role: 'button', name: 'Save', nth: 0, only: true }, settle: 2000 }
        ],
        answer: 'Bio updated.',
        verify: async ({ sh }) => db(sh, `select bio from person where name = '${ME}' and local`)[0]?.[0] === bio
      }
    },
    delete_post: async ({ rng, sh }) => {
      const mine = db(sh, `select p.id, p.name from post p join person pe on pe.id = p.creator_id where pe.name = '${ME}' and not p.deleted order by p.published desc limit 10`)
      if (!mine.length) return null
      const [id, title] = rng.pick(mine)
      return {
        goal: rng.pick([`Delete my post "${title}".`, `Remove the thread I started called "${title}".`]),
        start: `/post/${id}`,
        plan: [{ title: 'Open the post menu (More)', check: 'the menu shows Delete' }, { title: 'Click Delete', check: 'the post shows as deleted' }],
        steps: [
          { plan: 1, do: 'click', target: { role: 'button', name: 'More', nth: 0, only: true } },
          { plan: 2, do: 'click', target: { role: 'button', name: 'Delete', nth: 0, only: true }, settle: 2000 }
        ],
        answer: `Deleted "${title}".`,
        verify: async ({ sh }) => db(sh, `select deleted from post where id = ${id}`)[0][0] === 't'
      }
    },
    read_comments: async ({ rng, sh }) => {
      const c = rng.pick(communities(sh))
      const p = rng.pick(newest(sh, c).slice(0, 5))
      if (!p) return null
      const what = rng.pick(['comments', 'author', 'points'])
      const ans = { comments: `It has ${p.comments} comment${p.comments === 1 ? '' : 's'}.`, author: `${p.author} posted it.`, points: `It has ${p.score} point${p.score === 1 ? '' : 's'}.` }[what]
      const q = { comments: `How many comments does ${titleQ(p)} in ${c.title} have?`, author: `Who posted ${titleQ(p)} in ${c.title}?`, points: `What is the score of the post ${titleQ(p)} in c/${c.name}?` }[what]
      return {
        goal: q, start: `/c/${c.name}?sort=New`, writes: false,
        plan: [{ title: `Open ${titleQ(p)}`, check: `heading "${p.title}"` }],
        steps: [{ plan: 1, do: 'click', target: { role: 'link', name: p.title, nth: 0, only: true }, settle: 2000 }],
        answer: ans,
        verify: async ({ sh }) => {
          const [n, s] = db(sh, `select comments, score from post_aggregates where post_id = ${p.id}`)[0]
          return what === 'author' || (what === 'comments' ? Number(n) === p.comments : Number(s) === p.score)
        }
      }
    },
    search_post: async ({ rng, sh }) => {
      const c = rng.pick(communities(sh))
      const p = rng.pick(newest(sh, c, 12))
      if (!p) return null
      const words = p.title.split(/\s+/).filter((w) => w.length > 3).slice(0, 3).join(' ')
      return {
        goal: rng.pick([`Search Threadly for "${words}" and open the post ${titleQ(p)}. Who wrote it?`, `Find the post ${titleQ(p)} with search and tell me its author.`]),
        start: '/search', writes: false,
        plan: [{ title: 'Type the search words', check: `searchbox = ${words}` }, { title: 'Run the search', check: `link "${p.title}"` }, { title: `Open ${titleQ(p)}`, check: `heading "${p.title}"` }],
        steps: [
          { plan: 1, do: 'type', target: { role: /searchbox|textbox/, name: /Search/, nth: 0, only: true }, text: words },
          { plan: 2, do: 'click', target: { role: 'button', name: 'Search', nth: 0, only: true }, settle: 2500 },
          { plan: 3, do: 'click', target: { role: 'link', name: p.title, nth: 0, only: true }, settle: 2000 }
        ],
        answer: `${p.author} wrote ${titleQ(p)}.`,
        verify: async () => true
      }
    }
  }
}
