// Ghost 6 (Casper theme + Koenig editor) on blog.farm.test: a Medium-like blog. Seed: seed/ghost_seed.py
// (15 authors, 21 tags, 150 posts, 22 drafts). The writer is farmadmin (owner). State is read from Ghost's sqlite DB.
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ACCOUNTS = JSON.parse(readFileSync(join(here, '..', 'farm', 'accounts.json'), 'utf8'))
const DB = '/dev/shm/clone-farm/ghost/ghost.db'
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`
const sql = (sh, q) => { const out = sh(`sqlite3 -json ${DB}`, { input: q, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); return out ? JSON.parse(out) : [] }
const one = (sh, q) => sql(sh, q)[0]
const stripHtml = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()

/** Seed posts with their author and primary tag (cached: tasks never change the seed). */
let POSTS = null
function posts(sh) {
  if (POSTS) return POSTS
  POSTS = sql(sh, `select p.id, p.title, p.slug, p.status, p.html, p.featured, p.custom_excerpt as excerpt, p.published_at,
    u.name as author, u.slug as author_slug,
    (select t.name from posts_tags pt join tags t on t.id = pt.tag_id where pt.post_id = p.id order by pt.sort_order limit 1) as tag,
    (select t.slug from posts_tags pt join tags t on t.id = pt.tag_id where pt.post_id = p.id order by pt.sort_order limit 1) as tag_slug,
    (select group_concat(t.name, '|') from posts_tags pt join tags t on t.id = pt.tag_id where pt.post_id = p.id) as tags
    from posts p join posts_authors pa on pa.post_id = p.id and pa.sort_order = 0 join users u on u.id = pa.author_id
    where p.type = 'post' and u.email != 'ghost@example.com'`)
  return POSTS
}
const TAGS = ['Engineering', 'Design', 'Remote Work', 'Startups', 'Travel', 'Food', 'Money', 'Health', 'Climate', 'AI', 'Productivity',
  'Leadership', 'India', 'Books', 'Data', 'Careers', 'Open Source', 'Cities', 'Culture', 'Science']

/** A post that is on the first page of its author's list in the admin (newest first, 15 per page). */
function listed(sh, rng, status) {
  const all = posts(sh).filter((p) => p.status === status)
  for (let t = 0; t < 30; t++) {
    const p = rng.pick(all)
    const mine = posts(sh).filter((x) => x.author_slug === p.author_slug && x.status === status)
    const titles = mine.map((x) => x.title)
    if (titles.filter((x) => x === p.title).length === 1 && mine.length <= 14) return p
  }
  return null
}
const listPath = (p) => `/ghost/#/posts?type=${p.status}&author=${p.author_slug}`
/** Steps that open a post from its author's list in the admin. */
const openPost = (p, plan = 1) => ({ plan, do: 'click', target: { role: 'heading', name: p.title }, settle: 2500 })
const postRow = (sh, id) => one(sh, `select title, status, featured, custom_excerpt as excerpt, html from posts where id = ${lit(id)}`)
const tagsOf = (sh, id) => sql(sh, `select t.name from posts_tags pt join tags t on t.id = pt.tag_id where pt.post_id = ${lit(id)}`).map((r) => r.name)

// Text banks for new posts.
const NEW_TITLES = ['Five things I learned running a book club at work', 'How we halved our cloud bill', 'A slow weekend in Kochi',
  'Why our team writes decision logs', 'The quiet power of a weekly review', 'Notes from a first marathon', 'What a power cut taught me about backups',
  'Hiring our first designer', 'A beginner guide to filter coffee at home', 'Lessons from shipping a mobile app in six weeks',
  'Why I stopped using three to-do apps', 'Walking meetings, six months later', 'Our onboarding checklist, annotated', 'Cooking with millets this monsoon',
  'The spreadsheet that runs our household', 'Small habits that fixed my sleep', 'What we measure in code review', 'A day on the Mumbai local',
  'Building a reading habit in 2026', 'Making peace with Slack notifications', 'How we plan a team offsite on a budget', 'Notes on rooftop gardens',
  'The case for boring technology', 'What I wish I knew before freelancing', 'A field guide to remote pairing']
const NEW_BODIES = ['This is a short note on what worked for us and what did not.', 'We tried this for three months. Here is what changed.',
  'I kept a simple log every day and the pattern was clear by week four.', 'Most of the gains came from removing steps, not adding tools.',
  'Here is the plan we used, with the parts we would change next time.', 'The first version was rough, but it was good enough to learn from.']
const NEW_TAGS = ['Exploration', 'Field Report', 'Weekend', 'How-to', 'Opinion', 'Case Study', 'Interview', 'Checklist', 'Retrospective', 'Guide']

const tasks = {
  // Write and publish a new post with a title, body and tag.
  publish_post: async ({ rng, sh }) => {
    const title = `${rng.pick(NEW_TITLES)}${rng.chance(0.4) ? ` (${rng.pick(['part 2', 'revisited', 'a follow-up', '2026 edition'])})` : ''}`
    if (posts(sh).some((p) => p.title === title)) return null
    const body = rng.pick(NEW_BODIES)
    const tag = rng.pick(TAGS)
    const prefix = tag.slice(0, Math.max(3, Math.min(tag.length, rng.int(3, 5))))
    return {
      goal: rng.pick([`Write and publish a post titled "${title}" with the text "${body}" and the tag ${tag}.`,
        `Publish a new blog post "${title}". Body: "${body}" Tag it ${tag}.`,
        `Create a post called "${title}", write "${body}" as the body, add the ${tag} tag and publish it now.`]),
      start: '/ghost/#/posts',
      plan: [
        { title: 'Open a new post', check: 'textbox "Post title"' },
        { title: `Type the title "${title}"`, check: `textbox "Post title" = ${title}` },
        { title: 'Write the body text', check: `text "${body}"` },
        { title: `Add the tag ${tag} in post settings`, check: `the tag ${tag} is selected` },
        { title: 'Publish the post right now', check: 'the post is published' }
      ],
      steps: [
        { plan: 1, do: 'click', target: { role: 'link', name: 'New post' }, settle: 2500 },
        { plan: 2, do: 'type', target: { role: 'textbox', name: 'Post title' }, text: title },
        { plan: 3, do: 'click', target: { role: 'textbox', name: '' }, mayNotChange: true },
        { plan: 3, do: 'type', target: { role: 'textbox', name: '' }, text: body, settle: 2000 },
        { plan: 4, do: 'click', target: { role: 'button', name: 'Settings' } },
        { plan: 4, do: 'click', target: { role: 'combobox', name: 'Tags' } },
        { plan: 4, do: 'type', target: { role: 'combobox', name: 'Tags' }, text: prefix },
        { plan: 4, do: 'click', target: { role: 'option', name: tag }, settle: 1500 },
        { plan: 5, do: 'click', target: { role: 'button', name: 'Publish' } },
        { plan: 5, do: 'click', target: { role: 'button', name: /^Continue, final review/ } },
        { plan: 5, do: 'click', target: { role: 'button', name: 'Publish post, right now' }, settle: 3000 }
      ],
      answer: `Published "${title}" with the tag ${tag}.`,
      verify: async ({ sh }) => {
        const r = one(sh, `select id, status, html from posts where title = ${lit(title)} and type = 'post'`)
        return r?.status === 'published' && r.html.includes(body) && tagsOf(sh, r.id).includes(tag)
      }
    }
  },

  // Change the title of a published post and update it.
  edit_title: async ({ rng, sh }) => {
    const p = listed(sh, rng, 'published'); if (!p) return null
    const title = rng.pick([`${p.title}: an update`, `${p.title} (revised)`, `Revisited: ${p.title}`, `${p.title}, two years on`])
    return {
      goal: rng.pick([`Rename the post "${p.title}" to "${title}".`, `Change the title of "${p.title}" to "${title}" and update the post.`,
        `Edit ${p.author}'s post "${p.title}": the new title is "${title}".`]),
      start: listPath(p),
      plan: [{ title: `Open the post "${p.title}"`, check: `textbox "Post title" = ${p.title}` },
        { title: `Replace the title with "${title}"`, check: `textbox "Post title" = ${title}` },
        { title: 'Click Update', check: 'the post is updated' }],
      steps: [openPost(p), { plan: 2, do: 'type', target: { role: 'textbox', name: 'Post title' }, text: title },
        { plan: 3, do: 'click', target: { role: 'button', name: 'Update' }, settle: 2500 }],
      answer: `Renamed the post to "${title}".`,
      verify: async ({ sh }) => postRow(sh, p.id)?.title === title
    }
  },

  // Add a tag to a post from the post settings.
  add_tag: async ({ rng, sh }) => {
    const status = rng.chance(0.7) ? 'published' : 'draft'
    const p = listed(sh, rng, status); if (!p) return null
    const have = (p.tags ?? '').split('|')
    const tag = rng.pick(TAGS.filter((t) => !have.includes(t)))
    const prefix = tag.slice(0, Math.min(tag.length, rng.int(3, 5)))
    const steps = [openPost(p), { plan: 2, do: 'click', target: { role: 'button', name: 'Settings' } },
      { plan: 2, do: 'click', target: { role: 'combobox', name: 'Tags' } },
      { plan: 2, do: 'type', target: { role: 'combobox', name: 'Tags' }, text: prefix },
      { plan: 2, do: 'click', target: { role: 'option', name: tag }, settle: 2500 }]
    return {
      goal: rng.pick([`Add the tag ${tag} to the post "${p.title}".`, `Tag "${p.title}" with ${tag}.`, `The post "${p.title}" should also be under ${tag}. Add that tag.`]),
      start: listPath(p),
      plan: [{ title: `Open the post "${p.title}"`, check: `textbox "Post title" = ${p.title}` },
        { title: `Add the tag ${tag} in post settings`, check: `the tag ${tag} is selected` }],
      steps,
      answer: `Added the tag ${tag} to "${p.title}".`,
      verify: async ({ sh }) => tagsOf(sh, p.id).includes(tag)
    }
  },

  // Unpublish a post (revert it to a draft).
  unpublish: async ({ rng, sh }) => {
    const p = listed(sh, rng, 'published'); if (!p) return null
    return {
      goal: rng.pick([`Unpublish the post "${p.title}".`, `Take "${p.title}" offline and turn it back into a draft.`, `Revert ${p.author}'s post "${p.title}" to a draft.`]),
      start: listPath(p),
      plan: [{ title: `Open the post "${p.title}"`, check: `textbox "Post title" = ${p.title}` },
        { title: 'Click Unpublish and confirm', check: 'the post is a draft' }],
      steps: [openPost(p), { plan: 2, do: 'click', target: { role: 'button', name: 'Unpublish' } },
        { plan: 2, do: 'click', target: { role: 'button', name: /^Unpublish and revert to private draft/ }, settle: 2500 }],
      answer: `"${p.title}" is now a draft.`,
      verify: async ({ sh }) => postRow(sh, p.id)?.status === 'draft'
    }
  },

  // Delete a draft post.
  delete_post: async ({ rng, sh }) => {
    const p = listed(sh, rng, rng.chance(0.6) ? 'draft' : 'published'); if (!p) return null
    return {
      goal: rng.pick([`Delete the post "${p.title}".`, `Remove "${p.title}" from the blog for good.`, `Get rid of the post "${p.title}" by ${p.author}.`]),
      start: listPath(p),
      plan: [{ title: `Open the post "${p.title}"`, check: `textbox "Post title" = ${p.title}` },
        { title: 'Open post settings and click Delete post', check: 'a confirm dialog is shown' },
        { title: 'Confirm the delete', check: 'url contains #/posts' }],
      steps: [openPost(p), { plan: 2, do: 'click', target: { role: 'button', name: 'Settings' } },
        { plan: 2, do: 'click', target: { role: 'button', name: 'Delete post' } },
        { plan: 3, do: 'click', target: { role: 'button', name: /^Delete$/, inside: /Are you sure|delete/i }, settle: 2500 }],
      answer: `Deleted the post "${p.title}".`,
      verify: async ({ sh }) => !postRow(sh, p.id)
    }
  },

  // Mark a post as featured.
  feature_post: async ({ rng, sh }) => {
    const p = listed(sh, rng, 'published'); if (!p || p.featured) return null
    return {
      goal: rng.pick([`Feature the post "${p.title}".`, `Make "${p.title}" a featured post.`, `Pin "${p.title}" as featured on the blog.`]),
      start: listPath(p),
      plan: [{ title: `Open the post "${p.title}"`, check: `textbox "Post title" = ${p.title}` },
        { title: 'Open post settings and turn on Feature this post', check: 'switch "Feature this post" is checked' }],
      steps: [openPost(p), { plan: 2, do: 'click', target: { role: 'button', name: 'Settings' } },
        { plan: 2, do: 'click', target: { role: 'switch', name: 'Feature this post' }, settle: 2500 }],
      answer: `"${p.title}" is now featured.`,
      verify: async ({ sh }) => Number(postRow(sh, p.id)?.featured) === 1
    }
  },

  // Write the excerpt of a post.
  set_excerpt: async ({ rng, sh }) => {
    const p = listed(sh, rng, 'draft'); if (!p) return null
    const text = rng.pick(['A short look at what changed and why.', 'What we tried, what failed, and what stuck.', 'Three lessons from a year of small experiments.',
      'Practical notes for teams starting out.', 'A field report with numbers.'])
    return {
      goal: rng.pick([`Set the excerpt of the draft "${p.title}" to "${text}".`, `Give "${p.title}" the excerpt "${text}".`]),
      start: listPath(p),
      plan: [{ title: `Open the draft "${p.title}"`, check: `textbox "Post title" = ${p.title}` },
        { title: `Write the excerpt in post settings`, check: `textbox "Excerpt" = ${text}` },
        { title: 'Close the settings to save', check: 'the excerpt is saved' }],
      steps: [openPost(p), { plan: 2, do: 'click', target: { role: 'button', name: 'Settings' } },
        { plan: 2, do: 'type', target: { role: 'textbox', name: 'Excerpt' }, text },
        { plan: 3, do: 'click', target: { role: 'button', name: 'Settings' }, settle: 2500 }],
      answer: `Set the excerpt of "${p.title}".`,
      verify: async ({ sh }) => postRow(sh, p.id)?.excerpt === text
    }
  },

  // Create a new tag with a description.
  create_tag: async ({ rng, sh }) => {
    const name = rng.pick(NEW_TAGS)
    if (one(sh, `select 1 as x from tags where name = ${lit(name)}`)) return null
    const desc = rng.pick(['Posts from the field.', 'Short practical guides.', 'Longer pieces with numbers.', 'Notes and opinions from the team.'])
    return {
      goal: rng.pick([`Create a tag "${name}" with the description "${desc}".`, `Add a new tag called ${name}. Description: ${desc}`]),
      start: '/ghost/#/tags',
      plan: [{ title: 'Click New tag', check: 'textbox "Name"' }, { title: `Fill in the name and description`, check: `textbox "Name" = ${name}` },
        { title: 'Save the tag', check: 'the tag is saved' }],
      steps: [{ plan: 1, do: 'click', target: { role: 'link', name: 'New tag' }, settle: 2000 },
        { plan: 2, do: 'type', target: { role: 'textbox', name: 'Name' }, text: name },
        { plan: 2, do: 'type', target: { role: 'textbox', name: 'Description' }, text: desc },
        { plan: 3, do: 'click', target: { role: 'button', name: 'Save' }, settle: 2500 }],
      answer: `Created the tag ${name}.`,
      verify: async ({ sh }) => one(sh, `select description from tags where name = ${lit(name)}`)?.description === desc
    }
  },

  // Read a fact from a post on the public site (the tag page lists it).
  read_fact: async ({ rng, sh }) => {
    const pub = posts(sh).filter((p) => p.status === 'published' && p.tag_slug)
    const p = rng.pick(pub)
    // Only posts on the first page of their tag (newest first).
    const page1 = pub.filter((x) => (x.tags ?? '').split('|').includes(p.tag)).sort((a, b) => (b.published_at > a.published_at ? 1 : -1)).slice(0, 12)
    if (!page1.includes(p) || page1.filter((x) => x.title === p.title).length > 1) return null
    const text = stripHtml(p.html)
    const kind = rng.pick(['survey', 'city', 'time'])
    let goal; let answer
    if (kind === 'survey') {
      const m = text.match(/In a survey of (\d+) teams, (\d+)% said/); if (!m) return null
      goal = rng.pick([`In the post "${p.title}", what share of teams named it their biggest weekly time sink?`, `What percentage does "${p.title}" report from its survey?`])
      answer = `${m[2]}% of ${m[1]} teams.`
    } else if (kind === 'city') {
      const m = text.match(/The pilot ran in ([A-Z][a-z]+) for (\d+) weeks/); if (!m) return null
      goal = rng.pick([`Where did the pilot in "${p.title}" run, and for how long?`, `Read "${p.title}" and tell me the pilot city.`])
      answer = `${m[1]}, for ${m[2]} weeks.`
    } else {
      const m = text.match(/went from (\d+) minutes to (\d+) minutes/); if (!m) return null
      goal = rng.pick([`According to "${p.title}", what was the median time after the change?`, `How much time did the change in "${p.title}" save?`])
      answer = `From ${m[1]} minutes to ${m[2]} minutes.`
    }
    return {
      goal, start: `/tag/${p.tag_slug}/`, writes: false,
      plan: [{ title: `Open the post "${p.title}"`, check: `heading "${p.title}"` }, { title: 'Read the fact in the text', check: 'the answer is visible' }],
      steps: [{ plan: 1, do: 'click', target: { role: 'heading', name: p.title }, settle: 2000 }],
      answer,
      verify: async ({ snapshot }) => snapshot.includes((answer.match(/\d+/) ?? answer.match(/[A-Z][a-z]+/))[0]) && stripHtml(p.html).includes((answer.match(/\d+/) ?? answer.match(/[A-Z][a-z]+/))[0])
    }
  },

  // Who wrote a post (public site, from its tag page).
  read_author: async ({ rng, sh }) => {
    const pub = posts(sh).filter((p) => p.status === 'published' && p.tag_slug)
    const p = rng.pick(pub)
    const page1 = pub.filter((x) => (x.tags ?? '').split('|').includes(p.tag)).sort((a, b) => (b.published_at > a.published_at ? 1 : -1)).slice(0, 12)
    if (!page1.includes(p) || page1.filter((x) => x.title === p.title).length > 1) return null
    return {
      goal: rng.pick([`Who wrote "${p.title}"?`, `Find the author of the ${p.tag} post "${p.title}".`, `Open "${p.title}" and tell me the author.`]),
      start: `/tag/${p.tag_slug}/`, writes: false,
      plan: [{ title: `Open the post "${p.title}"`, check: `heading "${p.title}"` }, { title: 'Read the author name', check: `text "${p.author}"` }],
      steps: [{ plan: 1, do: 'click', target: { role: 'heading', name: p.title }, settle: 2000 }],
      answer: `${p.author} wrote it.`,
      verify: async ({ snapshot }) => snapshot.includes(p.author)
    }
  }
}

export default {
  name: 'ghost',
  family: 'blog',
  origin: 'http://blog.farm.test',
  portOffset: 33,
  explorePaths: ['/', '/tag/engineering/', '/tag/travel/', '/ghost/#/posts', '/ghost/#/tags'],
  async reset({ sh }) { sh('bash /workspace/clone-farm/ghost/reset.sh') },
  async login({ page, sleep }) {
    await page.goto('http://blog.farm.test/ghost/#/signin')
    await sleep(2500)
    if (!/signin/.test(page.url())) return
    await page.fill('input[name=identification]', 'farmadmin@farm.test')
    await page.fill('input[name=password]', ACCOUNTS.password)
    await page.click('button[type=submit]')
    await page.waitForURL(/#\/(dashboard|analytics|site|posts)/, { timeout: 30_000 })
    await sleep(1000)
  },
  // A task returns null when the random pick does not fit (ties, duplicates): try a few picks.
  tasks: Object.fromEntries(Object.entries(tasks).map(([k, fn]) => [k, async (ctx) => { for (let i = 0; i < 12; i++) { const s = await fn(ctx); if (s) return s } return null }]))
}
