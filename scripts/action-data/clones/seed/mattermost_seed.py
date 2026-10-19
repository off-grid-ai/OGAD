#!/usr/bin/env python3
"""Synthetic Slack-like workspace for Mattermost on chat.farm.test (no real people).

  python3 mattermost_seed.py            # against a fresh, empty `mattermost` DB with the server up

30 users (main persona meera.iyer), 2 teams, 16 channels (public + private), ~1200 channel posts
with threads, reactions, pins and ~200 direct messages spread over the last 50 days.
Every account uses the farm test password from clones/farm/accounts.json.
"""
import json, os, random, subprocess, time
import requests

R = random.Random(20261016)
HERE = os.path.dirname(os.path.abspath(__file__))
PASSWORD = json.load(open(os.path.join(HERE, '..', 'farm', 'accounts.json')))['password']
API = 'http://127.0.0.1:7120/api/v4'
MMCTL = ['/workspace/clone-farm/bin-native/mmctl', '--local']
os.environ['MMCTL_LOCAL_SOCKET_PATH'] = '/dev/shm/clone-farm/mattermost/local.sock'

NAMES = [('Meera', 'Iyer'), ('Rohan', 'Mehta'), ('Priya', 'Shah'), ('Kabir', 'Khan'), ('Asha', 'Rao'), ('Arjun', 'Nair'), ('Neha', 'Sharma'),
         ('Vikram', 'Das'), ('Isha', 'Kapoor'), ('Dev', 'Joshi'), ('Ananya', 'Bose'), ('Karan', 'Pillai'), ('Tara', 'Singh'), ('Nikhil', 'Menon'),
         ('Sana', 'Reddy'), ('Rahul', 'Gupta'), ('Leela', 'Fernandes'), ('Aditya', 'Kulkarni'), ('Zoya', 'Ali'), ('Farhan', 'Chatterjee'),
         ('Elena', 'Rossi'), ('Lucas', 'Silva'), ('Hana', 'Tanaka'), ('Mateo', 'Novak'), ('Grace', 'Okafor'), ('Noah', 'Berg'),
         ('Amara', 'Moreau'), ('Tenzin', 'Dorje'), ('Kavya', 'Verma'), ('Imran', 'Patel')]
ROLES = ['Engineering Manager', 'Backend Engineer', 'Product Manager', 'Designer', 'QA Lead', 'Frontend Engineer', 'Data Analyst', 'SRE',
         'Sales Lead', 'Store Operations', 'Marketing Manager', 'Finance Analyst', 'Support Lead', 'Mobile Engineer', 'Recruiter']

TEAMS = [('orbit', 'Orbit Labs'), ('monsoon', 'Monsoon Retail')]
# (team, name, display, private, purpose, topic kind)
CHANNELS = [
    ('orbit', 'engineering', 'Engineering', False, 'Day-to-day engineering talk', 'eng'),
    ('orbit', 'releases', 'Releases', False, 'Release dates, freezes and rollouts', 'release'),
    ('orbit', 'design', 'Design', False, 'Mockups, reviews and the design system', 'design'),
    ('orbit', 'backend', 'Backend', False, 'APIs, databases and services', 'eng'),
    ('orbit', 'mobile', 'Mobile', False, 'Android and iOS apps', 'eng'),
    ('orbit', 'product', 'Product', False, 'Roadmap and customer feedback', 'product'),
    ('orbit', 'incidents', 'Incidents', True, 'On-call and incident reviews', 'incident'),
    ('orbit', 'hiring', 'Hiring', True, 'Open roles and interview loops', 'hiring'),
    ('orbit', 'watercooler', 'Watercooler', False, 'Lunch, books and weekend plans', 'social'),
    ('monsoon', 'sales', 'Sales', False, 'Pipeline, deals and targets', 'sales'),
    ('monsoon', 'store-ops', 'Store Ops', False, 'Store openings, staffing and audits', 'ops'),
    ('monsoon', 'marketing', 'Marketing', False, 'Campaigns and launches', 'marketing'),
    ('monsoon', 'supply-chain', 'Supply Chain', False, 'Vendors, shipments and stock', 'ops'),
    ('monsoon', 'customer-support', 'Customer Support', False, 'Tickets and escalations', 'support'),
    ('monsoon', 'finance', 'Finance', True, 'Budgets, invoices and payouts', 'finance'),
    ('monsoon', 'leadership', 'Leadership', True, 'Leadership team only', 'product'),
]

PROJECTS = ['Atlas', 'Nimbus', 'Kestrel', 'Lotus', 'Orion', 'Saffron', 'Tidal', 'Monarch', 'Zephyr', 'Banyan']
CITIES = ['Pune', 'Bengaluru', 'Mumbai', 'Delhi', 'Hyderabad', 'Chennai', 'Goa', 'Jaipur', 'Kochi', 'Indore']
DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
MONTHS = ['Oct', 'Nov', 'Dec']
VENDORS = ['Northwind Traders', 'Bluefin Logistics', 'Greenleaf Farms', 'Pixelforge', 'Skyroute Cargo', 'Acme Packaging', 'Brightdesk']
TOOLS = ['Grafana', 'Sentry', 'the staging cluster', 'the CI pipeline', 'Postgres', 'Redis', 'the feature flag service', 'the CDN']
BOOKS = ['Project Hail Mary', 'The Midnight Library', 'Sapiens', 'Atomic Habits', 'The Overstory', 'Shantaram']
FOODS = ['biryani', 'dosa', 'ramen', 'pizza', 'thali', 'tacos', 'momos', 'pav bhaji']

TEMPLATES = {
    'eng': [
        'The {project} API now returns paginated results, page size is {n} by default.',
        'I moved the {project} build to {tool}; it now takes {m} minutes instead of {m2}.',
        'Heads up: {tool} will be down for maintenance on {day} from {h}:00 to {h2}:00.',
        'Code freeze for {project} starts {day}. Please merge your PRs before then.',
        'Found the cause of the flaky login test: a race in the session cache. Fix is in review.',
        'Can someone review my PR for the {project} search endpoint? It adds fuzzy matching.',
        'We hit {n} requests per second on {project} during the load test with p95 at {m}0 ms.',
        'Reminder: tech debt day is this {day}. Pick a ticket from the {project} backlog.',
        'I upgraded {tool} to the latest version on staging. No issues so far.',
        'The {project} migration script ran on {n} thousand rows in {m} minutes.',
        'Proposal: we drop support for Android 9 in {project} from the {month} release.',
        'Pairing session on the {project} caching layer at {h}:30 today, anyone welcome.',
        'Our test coverage for {project} is now {n} percent, up from {n2} percent.',
        'The memory leak in {project} was in the image resizer. Patched and deployed.',
    ],
    'release': [
        'The {project} {v} release is planned for {d} {month}. QA sign-off is due {d2} {month}.',
        '{project} {v} is live for {n} percent of users. Full rollout on {day} if metrics stay green.',
        'Release notes for {project} {v} are in the wiki. Please add your changes by {day}.',
        'We are rolling back {project} {v} because of a crash on checkout. Hotfix ETA {h}:00.',
        'Release train for {month}: {project} {v}, then the {project2} beta a week later.',
        'Changelog for {project} {v}: dark mode, faster search and {n} bug fixes.',
        'The {project} {v} build passed all {n}0 smoke tests on staging.',
        'App store review for {project} {v} is approved. Publishing {day} morning.',
    ],
    'design': [
        'New mockups for the {project} onboarding flow are up in Figma. Feedback by {day} please.',
        'We are switching the primary button colour to teal across {project}.',
        'Design review for {project} settings page is on {day} at {h}:00.',
        'Usability test results for {project}: {m} of 10 people found the search bar on first try.',
        'Icon set v{n} is ready, {m}0 new icons including calendar and invoice.',
        'I simplified the {project} checkout to three steps instead of five.',
        'Typography update: body text goes from 14 to 15 px in {project}.',
    ],
    'product': [
        'Customer feedback this week: {n} requests for CSV export in {project}.',
        'The {project} roadmap for {month} is final: offline mode, shared lists and SSO.',
        'Our NPS for {project} went from {n2} to {n} after the last release.',
        'We decided to pause the {project} referral program until {month}.',
        'Pricing for {project} Pro stays at Rs {p} per seat per month.',
        'Beta signups for {project} reached {n}00 this week.',
        'Planning meeting for {project} {month} goals is on {day} at {h}:00.',
        'Top churn reason for {project} last quarter: missing integrations.',
    ],
    'incident': [
        'Incident: {project} checkout errors spiked to {n} percent at {h}:{mm}. Rolled back at {h2}:{mm}.',
        'Postmortem for the {project} outage is scheduled for {day} at {h}:00.',
        'Root cause of the {project} outage: an expired TLS certificate on {tool}.',
        'On-call this week is me. Escalate {project} pages to the backup after 15 minutes.',
        'Alert threshold for {project} latency is now {m}00 ms.',
        'The {project} database failover took {m} minutes. Target is under 2.',
    ],
    'hiring': [
        'We have {n} open roles for {project}: two backend and one designer.',
        'Interview loop for the SRE candidate is on {day}. I need two panelists.',
        'Offer accepted for the frontend role. Joining date is {d} {month}.',
        'Referral bonus is now Rs {p}0 for engineering roles.',
        'The take-home task for {project} candidates is updated to 3 hours max.',
        'Campus hiring trip to {city} is planned for {d} {month}.',
    ],
    'social': [
        'Anyone up for {food} for lunch today?',
        'Just finished {book}. Highly recommend it.',
        'Weekend trip to {city} was amazing, photos soon.',
        'Board game night on {day} at 7 in the {city} office.',
        'The new coffee machine on floor {n} finally works.',
        'Cricket match this {day} evening, we need two more players.',
        'Book club pick for {month}: {book}.',
    ],
    'sales': [
        'Closed the {vendor} deal: Rs {p} lakh annual contract.',
        'Pipeline for {month} is Rs {n} crore across {m}0 deals.',
        'Demo for {vendor} is on {day} at {h}:00. I need someone from product.',
        'The {city} region hit {n} percent of its quarterly target.',
        'Discount approval needed for {vendor}: {m} percent on a 2 year term.',
        'Lost the {vendor} renewal to a competitor on price.',
        'New lead from the {city} expo: {vendor}, about {n}0 stores.',
    ],
    'ops': [
        'The {city} store opening moved to {d} {month}.',
        'Shipment from {vendor} is delayed by {m} days at the port.',
        'Stock audit at the {city} warehouse found {n} missing cartons.',
        'We need {m} extra staff for the {city} store during the sale weekend.',
        'New vendor {vendor} is onboarded for packaging from {month}.',
        'Cold storage in {city} was down for {m} hours; no stock lost.',
        'Delivery SLA for {city} is now {m} days.',
    ],
    'marketing': [
        'The Diwali campaign goes live on {d} {month} with a budget of Rs {p} lakh.',
        'Email open rate for the {month} newsletter was {n} percent.',
        'Influencer shoot in {city} is booked for {day}.',
        'New tagline draft: "Fresh every day, for every home." Thoughts?',
        'The {project} landing page got {n}00 signups in the first week.',
        'Billboards in {city} go up on {d} {month}.',
    ],
    'support': [
        'Ticket backlog is down to {n} from {n2}0 last week.',
        'Escalation: {vendor} reports wrong invoices for {m} orders.',
        'First response time this week is {m} hours on average.',
        'New macro for refund requests is live in the help desk.',
        'Top complaint this week: late deliveries in {city}.',
        'CSAT for {month} is {n} percent.',
    ],
    'finance': [
        'Q3 budget for marketing is Rs {p} lakh, {m} percent under plan.',
        'Invoices from {vendor} are due on {d} {month}.',
        'Payroll runs on the {d}th this month because of the holiday.',
        'Travel policy update: hotel cap in {city} is Rs {p}00 per night.',
        'Audit fieldwork starts {d} {month}. Please keep receipts ready.',
        'We paid {vendor} Rs {p} thousand for the {month} order.',
    ],
}
REPLIES = ['Thanks {first}!', 'Agreed, let us go with that.', 'Can we move it to {day}?', 'I will update the tracker.', 'Nice work!',
           'Is there a doc for this?', 'Looping in {first2} for this.', '+1', 'Sounds good to me.', 'Let me check and get back by {h}:00.',
           'Done, see the latest build.', 'Do we have numbers for last month too?', 'I can take this one.', 'Blocked on {tool} access, can someone help?',
           'Shared the notes in the wiki.', 'Great, thanks for the quick fix.', 'Which {project} version is this?', 'Can you add me to the invite?']
DMS = ['Hey, do you have a minute for a quick call?', 'Can you send me the {project} deck?', 'Thanks for covering for me on {day}.',
       'Lunch at {h}:30?', 'I left comments on your doc.', 'Are we still on for the {project} sync?', 'Can you review my PR when you get time?',
       'I will be out on {day}, back on {day2}.', 'The {vendor} contract is in your inbox.', 'Happy birthday! 🎉', 'Where is the {city} offsite this year?',
       'Your expense report needs a receipt for the {city} trip.', 'Can you take my on-call shift on {day}?', 'Got it, thanks.']
EMOJIS = ['+1', 'tada', 'heart', 'eyes', 'white_check_mark', 'rocket', 'joy', 'pray', 'fire', '100']


def fill(t, author):
    others = [n for n in NAMES if n[0] != author[0]]
    return t.format(project=R.choice(PROJECTS), project2=R.choice(PROJECTS), n=R.randint(12, 95), n2=R.randint(2, 9), m=R.randint(2, 9),
                    m2=R.randint(12, 40), h=R.randint(9, 16), h2=R.randint(17, 20), mm=R.choice(['05', '15', '30', '45', '50']),
                    day=R.choice(DAYS), day2=R.choice(DAYS), d=R.randint(3, 28), d2=R.randint(3, 28), month=R.choice(MONTHS),
                    v=f'{R.randint(1, 4)}.{R.randint(0, 9)}', tool=R.choice(TOOLS), city=R.choice(CITIES), vendor=R.choice(VENDORS),
                    p=R.randint(2, 90), book=R.choice(BOOKS), food=R.choice(FOODS), first=R.choice(others)[0], first2=R.choice(others)[0])


def uname(n): return f'{n[0].lower()}.{n[1].lower()}'


class S:
    def __init__(self, token): self.s = requests.Session(); self.s.headers['Authorization'] = f'Bearer {token}'
    def req(self, m, path, **kw):
        r = self.s.request(m, API + path, timeout=60, **kw)
        if r.status_code >= 300: raise RuntimeError(f'{m} {path} -> {r.status_code} {r.text[:300]}')
        return r.json() if r.text else None


def login(username):
    r = requests.post(API + '/users/login', json={'login_id': username, 'password': PASSWORD}, timeout=60)
    r.raise_for_status()
    return S(r.headers['Token']), r.json()


def backdate(stamps):
    """Spread posts over the past weeks (the API stamps them now), then fix channel/thread times."""
    rows = '\n'.join(f"('{i}',{t})" for i, t in stamps)
    sql = f"""
create temp table st(id varchar(26), t bigint);
insert into st values {rows.replace(chr(10), ',')};
update posts p set createat = st.t, updateat = st.t from st where p.id = st.id;
update posts p set createat = (select min(createat) from st join posts q on q.id = st.id where q.channelid = p.channelid) - 3600000
  where p.type like 'system_%' and exists (select 1 from st join posts q on q.id = st.id where q.channelid = p.channelid);
update reactions r set createat = p.createat + 600000, updateat = p.createat + 600000 from posts p where r.postid = p.id;
update threads t set lastreplyat = (select max(c.createat) from posts c where c.rootid = t.postid);
update channels c set lastpostat = coalesce((select max(p.createat) from posts p where p.channelid = c.id), c.lastpostat),
  lastrootpostat = coalesce((select max(p.createat) from posts p where p.channelid = c.id and p.rootid = ''), c.lastrootpostat);
update channelmembers m set lastviewedat = c.lastpostat, msgcount = c.totalmsgcount, msgcountroot = c.totalmsgcountroot, mentioncount = 0, mentioncountroot = 0, urgentmentioncount = 0 from channels c where m.channelid = c.id;
"""
    subprocess.run(['su', 'postgres', '-c', 'psql -q -v ON_ERROR_STOP=1 -d mattermost'], input=sql, text=True, check=True)


def main():
    subprocess.run(MMCTL + ['user', 'create', '--email', 'farmadmin@farm.test', '--username', 'farmadmin', '--password', PASSWORD, '--system-admin'], check=False, capture_output=True)
    admin, _ = login('farmadmin')
    users = {}
    for i, n in enumerate(NAMES):
        u = uname(n)
        try:
            users[u] = admin.req('POST', '/users', json={'username': u, 'email': f'{u}@farm.test', 'password': PASSWORD, 'first_name': n[0], 'last_name': n[1],
                                                         'position': ROLES[i % len(ROLES)]})
        except RuntimeError:
            users[u] = admin.req('GET', f'/users/username/{u}')
    ids = {u: users[u]['id'] for u in users}
    unames = list(users)
    me = 'meera.iyer'
    teams = {}
    for name, disp in TEAMS:
        try: teams[name] = admin.req('POST', '/teams', json={'name': name, 'display_name': disp, 'type': 'O'})
        except RuntimeError: teams[name] = admin.req('GET', f'/teams/name/{name}')
    members = {'orbit': unames[:22], 'monsoon': [me] + unames[10:]}
    for t, ms in members.items():
        for u in ms: admin.req('POST', f'/teams/{teams[t]["id"]}/members', json={'team_id': teams[t]['id'], 'user_id': ids[u]})
    sessions = {}
    for u in unames:
        sessions[u] = login(u)[0]
        # Skip tours and tips so the UI opens straight to the channel.
        prefs = [{'user_id': ids[u], 'category': c, 'name': nm, 'value': v} for c, nm, v in [
            ('tutorial_step', ids[u], '999'), ('recommended_next_steps', 'hide', 'true'), ('onboarding_task_list', 'onboarding_task_list_show', 'false'),
            ('onboarding_task_list', 'onboarding_task_list_open', 'false'), ('insights', 'insights_tutorial_state', '{"insights_modal_viewed":true}'),
            ('crt_thread_pane_step', ids[u], '999'), ('crt_tutorial_triggered', ids[u], '999'), ('crt_tutorial_auto_tour_status', ids[u], 'false'),
            ('actions_menu', 'actions_menu_tutorial_state', '{"actions_menu_modal_viewed":true}'), ('drafts', 'drafts_tour_tip_showed', '{"drafts_tour_tip_showed":true}'),
            ('app_bar', 'channel_with_board_tip_showed', '{"channel_with_board_tip_showed":true}'), ('display_settings', 'collapsed_reply_threads', 'off'),
            ('touched', 'invite_members', 'true'), ('use_case_preferences', ids[u], 'skip')]]
        admin.req('PUT', f'/users/{ids[u]}/preferences', json=prefs)

    now = int(time.time() * 1000)
    day = 86_400_000
    total = 0
    stamps = []  # the API ignores create_at: posts are back-dated in SQL at the end
    for team, name, disp, private, purpose, kind in CHANNELS:
        tid = teams[team]['id']
        try:
            ch = admin.req('POST', '/channels', json={'team_id': tid, 'name': name, 'display_name': disp, 'purpose': purpose, 'header': purpose, 'type': 'P' if private else 'O'})
        except RuntimeError:
            ch = admin.req('GET', f'/teams/{tid}/channels/name/{name}')
        pool = [u for u in members[team] if u == me or R.random() < (0.55 if private else 0.85)]
        if me not in pool: pool.append(me)
        for u in pool: admin.req('POST', f'/channels/{ch["id"]}/members', json={'user_id': ids[u]})
        n_root = R.randint(62, 80)
        times = sorted(now - R.randint(60_000, 50 * day) for _ in range(n_root))
        for k, ts in enumerate(times):
            author = R.choice(pool)
            n = NAMES[unames.index(author)]
            post = sessions[author].req('POST', '/posts', json={'channel_id': ch['id'], 'message': fill(R.choice(TEMPLATES[kind]), n)})
            stamps.append((post['id'], ts))
            total += 1
            if R.random() < 0.3:
                rt = ts
                for _ in range(R.randint(1, 5)):
                    rt += R.randint(60_000, 3 * 3_600_000)
                    if rt > now - 30_000: break
                    ra = R.choice(pool); rn = NAMES[unames.index(ra)]
                    reply = sessions[ra].req('POST', '/posts', json={'channel_id': ch['id'], 'root_id': post['id'], 'message': fill(R.choice(REPLIES), rn)})
                    stamps.append((reply['id'], rt))
                    total += 1
            for ra in R.sample(pool, min(len(pool), R.choice([0, 0, 0, 1, 1, 2, 3]))):
                sessions[ra].req('POST', '/reactions', json={'user_id': ids[ra], 'post_id': post['id'], 'emoji_name': R.choice(EMOJIS)})
            if R.random() < 0.04: admin.req('POST', f'/posts/{post["id"]}/pin')
    # Direct messages: the persona with 10 people, plus some other pairs.
    pairs = [(me, u) for u in R.sample([u for u in unames if u != me], 10)] + [tuple(R.sample(unames[1:], 2)) for _ in range(8)]
    for a, b in pairs:
        dm = sessions[a].req('POST', '/channels/direct', json=[ids[a], ids[b]])
        for x, y in ((a, b), (b, a)):  # keep the DM in both sidebars
            admin.req('PUT', f'/users/{ids[x]}/preferences', json=[{'user_id': ids[x], 'category': 'direct_channel_show', 'name': ids[y], 'value': 'true'}])
        ts = now - R.randint(2 * day, 30 * day)
        for _ in range(R.randint(6, 16)):
            ts += R.randint(60_000, day // 2)
            if ts > now - 30_000: break
            w = R.choice([a, b])
            dmp = sessions[w].req('POST', '/posts', json={'channel_id': dm['id'], 'message': fill(R.choice(DMS), NAMES[unames.index(w)])})
            stamps.append((dmp['id'], ts))
            total += 1
    backdate(stamps)
    # Admin access token for reset.sh (POST /caches/invalidate after the DB swap); server-only file.
    me_admin = admin.req('GET', '/users/me')
    tok = admin.req('POST', f'/users/{me_admin["id"]}/tokens', json={'description': 'farm reset'})
    os.makedirs('/workspace/clone-farm/mattermost', exist_ok=True)
    open('/workspace/clone-farm/mattermost/admin.token', 'w').write(tok['token'])
    print(json.dumps({'users': len(unames), 'teams': len(teams), 'channels': len(CHANNELS), 'posts': total}))


if __name__ == '__main__':
    main()
