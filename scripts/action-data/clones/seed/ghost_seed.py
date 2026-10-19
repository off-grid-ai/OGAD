"""Seed Ghost (blog.farm.test): owner, 15 authors, ~20 tags, 150 posts (published + drafts) with readable facts.
Run on the server with Ghost freshly initialised:  python3 ghost_seed.py <password>
Writes the owner via the setup API, authors straight into sqlite, posts via the Admin API (session login)."""
import json, random, sqlite3, sys, time, uuid, os
from datetime import datetime, timedelta
import requests
sys.path.insert(0, os.path.dirname(__file__))
from data_common import people, slug, CITIES

PW = sys.argv[1]
DB = '/dev/shm/clone-farm/ghost/ghost.db'
B = 'http://127.0.0.1:7136/ghost/api/admin'
H = {'Origin': 'http://blog.farm.test', 'Accept-Version': 'v6.0', 'Host': 'blog.farm.test'}
rng = random.Random(20261016)

s = requests.Session(); s.headers.update(H)
r = s.post(f'{B}/authentication/setup/', json={'setup': [{'name': 'Farm Admin', 'email': 'farmadmin@farm.test', 'password': PW, 'blogTitle': 'Field Notes'}]})
print('setup', r.status_code)
r = s.post(f'{B}/session/', json={'username': 'farmadmin@farm.test', 'password': PW}); print('session', r.status_code, r.text[:200])

# Authors: rows cloned from the owner (same password hash), role Author/Editor.
db = sqlite3.connect(DB)
owner = db.execute("select id, password from users where email='farmadmin@farm.test'").fetchone()
roles = dict(db.execute('select name, id from roles').fetchall())
names = people(rng, 15)
BIOS = ['Writes about {t} and the people behind it.', 'Product person in {c}. Notes on {t}.', 'Engineer, reader, occasional runner. Mostly {t}.',
        'Covers {t} from {c}.', 'Editor. Interested in {t}, maps and long walks.']
TOPICS = ['engineering', 'design', 'remote work', 'startups', 'travel', 'food', 'personal finance', 'health', 'climate', 'AI', 'productivity', 'leadership']
now = datetime(2026, 10, 1)
authors = []
for i, n in enumerate(names):
    uid = uuid.uuid4().hex[:24]
    email = slug(n).replace('-', '.') + '@farm.test'
    city = rng.choice(CITIES)
    bio = rng.choice(BIOS).format(t=rng.choice(TOPICS), c=city)
    ts = (now - timedelta(days=400 - i)).strftime('%Y-%m-%d %H:%M:%S')
    db.execute("""insert into users (id, name, slug, password, email, bio, location, status, visibility, created_at, updated_at)
                  values (?,?,?,?,?,?,?,?,?,?,?)""", (uid, n, slug(n), owner[1], email, bio, city, 'active', 'public', ts, ts))
    db.execute('insert into roles_users (id, role_id, user_id) values (?,?,?)', (uuid.uuid4().hex[:24], roles['Editor' if i < 3 else 'Author'], uid))
    authors.append((uid, n))
db.commit(); db.close()

TAGS = ['Engineering', 'Design', 'Remote Work', 'Startups', 'Travel', 'Food', 'Money', 'Health', 'Climate', 'AI', 'Productivity',
        'Leadership', 'India', 'Books', 'Data', 'Careers', 'Open Source', 'Cities', 'Culture', 'Science']
SUBJ = {
  'Engineering': ['build times', 'code review', 'on-call rotations', 'database migrations', 'test suites', 'deploy pipelines'],
  'Design': ['onboarding screens', 'design systems', 'icon sets', 'checkout flows', 'empty states', 'type scales'],
  'Remote Work': ['async standups', 'time zones', 'home offices', 'team offsites', 'meeting load', 'written updates'],
  'Startups': ['seed rounds', 'first hires', 'pricing pages', 'churn', 'pilot customers', 'runway'],
  'Travel': ['night trains', 'Kerala backwaters', 'Lisbon trams', 'monsoon trips', 'carry-on packing', 'hill stations'],
  'Food': ['filter coffee', 'sourdough', 'street food', 'millet recipes', 'meal prep', 'spice blends'],
  'Money': ['index funds', 'emergency funds', 'tax season', 'budgets', 'credit cards', 'salary negotiations'],
  'Health': ['sleep', 'running', 'standing desks', 'screen time', 'strength training', 'hydration'],
  'Climate': ['rooftop solar', 'heat waves', 'electric buses', 'water tables', 'urban trees', 'carbon budgets'],
  'AI': ['small models', 'local inference', 'evaluation sets', 'prompt libraries', 'agents', 'labelled data'],
  'Productivity': ['to-do lists', 'deep work', 'calendar blocking', 'inbox zero', 'note systems', 'weekly reviews'],
  'Leadership': ['one-on-ones', 'hiring loops', 'feedback', 'team charters', 'promotions', 'roadmaps'],
}
TITLE_T = ['What we learned about {s}', 'A field guide to {s}', 'Why {s} matter more than you think', 'Notes on {s}',
           'How we fixed our {s}', 'The case against {s}', '{S}: a year in review', 'Ten small lessons about {s}',
           'Rethinking {s}', 'Getting {s} right', 'Everything I got wrong about {s}', 'A short history of {s}']
OPEN = ['This started as a side note in a team retro.', 'I did not plan to write this post.', 'Every team I know struggles with this.',
        'Last quarter we finally ran the numbers.', 'A reader asked me about this, so here is a longer answer.']
MID = ['The first fix was boring: we wrote things down.', 'Most of the gain came from removing steps, not adding tools.',
       'We tried three approaches before one stuck.', 'Small, frequent changes beat one big rewrite.', 'The data surprised us.',
       'Nobody owned the problem until we gave it a name.', 'It took six weeks to see a real difference.',
       'We kept a simple log and reviewed it every Friday.', 'The cheapest option turned out to be the best one.']
CLOSE = ['If you try this, tell me how it goes.', 'We will share an update next quarter.', 'Start small, measure, repeat.',
         'None of this is new, but it works.', 'Thanks to everyone who read the drafts.']

posts = []
used = set()
for i in range(150):
    tag = rng.choice(list(SUBJ))
    subj = rng.choice(SUBJ[tag])
    for _ in range(20):
        t = rng.choice(TITLE_T).format(s=subj, S=subj[0].upper() + subj[1:])
        if t not in used: break
    if t in used: t = f'{t} ({i})'
    used.add(t)
    a = rng.choice(authors)
    pct, n_teams, before, after = rng.randint(12, 88), rng.choice([40, 60, 120, 250, 400]), rng.randint(15, 60), 0
    after = rng.randint(3, before - 2)
    city = rng.choice(CITIES)
    fact = f'In a survey of {n_teams} teams, {pct}% said {subj} were their biggest weekly time sink.'
    fact2 = f'After the change, the median time went from {before} minutes to {after} minutes.'
    fact3 = f'The pilot ran in {city} for {rng.randint(3, 12)} weeks.'
    paras = [rng.choice(OPEN) + f' This post is about {subj}.', fact + ' ' + rng.choice(MID), rng.choice(MID) + ' ' + fact3,
             f'<h2>What changed</h2>', rng.choice(MID) + ' ' + fact2, rng.choice(CLOSE)]
    html = ''.join(p if p.startswith('<h2') else f'<p>{p}</p>' for p in paras)
    extra = rng.sample([x for x in TAGS if x != tag], rng.randint(0, 2))
    status = 'draft' if rng.random() < 0.15 else 'published'
    pub = (now - timedelta(days=rng.randint(1, 360), hours=rng.randint(0, 23))).strftime('%Y-%m-%dT%H:%M:%S.000Z')
    body = {'title': t, 'html': html, 'status': status, 'tags': [{'name': tag}] + [{'name': x} for x in extra], 'authors': [{'id': a[0]}],
            'custom_excerpt': f'{fact}'[:290], 'featured': rng.random() < 0.08}
    if status == 'published': body['published_at'] = pub
    r = s.post(f'{B}/posts/?source=html', json={'posts': [body]})
    if r.status_code >= 300: print('post fail', r.status_code, r.text[:300]); continue
    posts.append(t)
print('posts', len(posts))
