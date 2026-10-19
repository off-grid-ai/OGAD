"""Seed Etherpad (docs.farm.test): 66 pads (meeting notes, proposals, specs, plans) with headings, bullets and bold,
plus a JSON index of each pad's facts (seed/etherpad_facts.json is written to /workspace/clone-farm/snap/etherpad/).
Uses the HTTP API (createPad + setHTML). Run on the server:  python3 etherpad_seed.py"""
import json, os, random, sys, requests
sys.path.insert(0, os.path.dirname(__file__))
from data_common import people, CITIES, COMPANIES

KEY = open('/workspace/clone-farm/etherpad/APIKEY.txt').read().strip()
API = 'http://127.0.0.1:7132/api/1.3.0'
SNAP = '/workspace/clone-farm/snap/etherpad'
os.makedirs(SNAP, exist_ok=True)
rng = random.Random(7781)


def call(fn, **p):
    r = requests.post(f'{API}/{fn}', data={'apikey': KEY, **p}); j = r.json()
    if j.get('code') != 0: raise RuntimeError(f'{fn}: {j}')
    return j.get('data')


for pid in (call('listAllPads') or {}).get('padIDs', []): call('deletePad', padID=pid)

TEAMS = ['Platform', 'Mobile', 'Growth', 'Data', 'Design', 'Payments', 'Support', 'Infra', 'Security', 'Sales Ops']
TOPICS = ['CI pipeline', 'onboarding flow', 'invoice export', 'search ranking', 'push notifications', 'data retention', 'pricing page',
          'SSO login', 'offline mode', 'audit logs', 'refund flow', 'dark mode', 'partner API', 'billing alerts', 'help centre']
pads, facts = [], {}


def slug(s):
    import re
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')


def ul(items): return '<ul>' + ''.join(f'<li>{x}</li>' for x in items) + '</ul>'


# Meeting notes
for i in range(24):
    team = rng.choice(TEAMS); d = f'2026-{rng.randint(7, 9):02d}-{rng.randint(1, 28):02d}'
    q = rng.choice(['Q3', 'Q3', 'Q4'])
    att = people(rng, rng.randint(3, 6)); owner = att[0]
    topic = rng.choice(TOPICS)
    actions = [f'{att[1]} to share the {topic} draft by Friday', f'{att[2]} to book a review with {rng.choice(COMPANIES)}', f'{owner} to update the {q} roadmap']
    decision = rng.choice([f'Ship the {topic} beta to 10% of users', f'Pause work on {topic} until {q} planning', f'Move the {topic} launch to {d[:7]}-30', f'Hire one more engineer for {topic}'])
    title = f'{team} weekly sync {d}'
    html = (f'<h1>{title}</h1><p><strong>Attendees:</strong> {", ".join(att)}</p><h2>Agenda</h2>' + ul([f'{q} goals review', f'Status of the {topic}', 'Hiring update', 'Open questions'])
            + f'<h2>Notes</h2><p>The team reviewed the {q} goals. {att[1]} said the {topic} work is {rng.randint(40, 90)}% done. Support tickets about it went down by {rng.randint(5, 40)}% this month.</p>'
            + f'<h2>Decision</h2><p>{decision}.</p><h2>Action items</h2>' + ul(actions))
    pid = f'{slug(team)}-sync-{d}'
    if pid in facts: continue
    pads.append((pid, html)); facts[pid] = {'kind': 'meeting', 'title': title, 'team': team, 'date': d, 'owner': owner, 'attendees': att, 'decision': decision, 'quarter': q, 'topic': topic}

# Proposals
for i in range(18):
    topic = rng.choice(TOPICS); owner = rng.choice(people(rng, 5)); cost = rng.choice([180000, 240000, 420000, 650000, 900000, 1250000])
    weeks = rng.randint(3, 14); q = rng.choice(['Q3', 'Q4'])
    vendor = rng.choice(COMPANIES)
    title = f'Proposal: rework the {topic}'
    if any(f['title'] == title for f in facts.values()): title = f'Proposal: rework the {topic} ({vendor})'
    html = (f'<h1>{title}</h1><p><strong>Owner:</strong> {owner}. <strong>Status:</strong> Draft for {q} review.</p><h2>Summary</h2>'
            f'<p>We propose to rebuild the {topic} with {vendor} as the main partner. The work takes about {weeks} weeks.</p><h2>Problem</h2>'
            f'<p>Today the {topic} causes {rng.randint(20, 300)} support tickets per month and slows down releases.</p><h2>Plan</h2>'
            + ul([f'Week 1: agree scope with {vendor}', f'Weeks 2-{weeks - 1}: build and test', f'Week {weeks}: roll out to all users'])
            + f'<h2>Cost</h2><p>Total cost is Rs {cost:,} for {q}.</p><h2>Risks</h2>' + ul(['Vendor delays', 'Data migration issues', 'Team capacity']))
    pid = f'proposal-{slug(topic)}-{i + 1}'
    pads.append((pid, html)); facts[pid] = {'kind': 'proposal', 'title': title, 'owner': owner, 'cost': cost, 'weeks': weeks, 'vendor': vendor, 'quarter': q, 'topic': topic}

# Specs
for i in range(15):
    topic = TOPICS[i % len(TOPICS)]; owner = rng.choice(people(rng, 5)); q = rng.choice(['Q3', 'Q4'])
    limit = rng.choice([50, 100, 200, 500, 1000]); lat = rng.choice([200, 300, 500, 800])
    title = f'Spec: {topic}'
    html = (f'<h1>{title}</h1><p><strong>Author:</strong> {owner}. Target: {q} 2026.</p><h2>Goals</h2>'
            + ul([f'Make the {topic} faster', 'Keep it simple to use', f'Support up to {limit} items per request'])
            + '<h2>Non-goals</h2>' + ul(['A new design system', 'Mobile-only features'])
            + f'<h2>Requirements</h2><p>The {topic} must answer in under {lat} ms at the 95th percentile. It must log every change for audit.</p>'
            + '<h2>Open questions</h2>' + ul([f'Who owns the {topic} after launch?', 'Do we need a feature flag?']))
    pid = f'spec-{slug(topic)}'
    pads.append((pid, html)); facts[pid] = {'kind': 'spec', 'title': title, 'owner': owner, 'limit': limit, 'latency': lat, 'quarter': q, 'topic': topic}

# Plans / trips
for i in range(10):
    city = rng.choice(CITIES); d = f'2026-{rng.randint(10, 12):02d}-{rng.randint(1, 28):02d}'; n = rng.randint(8, 40); budget = rng.choice([150000, 300000, 500000, 800000])
    title = f'Team offsite in {city}'
    if any(f['title'] == title for f in facts.values()): title = f'Team offsite in {city} ({d[:7]})'
    html = (f'<h1>{title}</h1><p>Date: {d}. People: {n}. Budget: Rs {budget:,}.</p><h2>Schedule</h2>'
            + ul(['Day 1: travel and dinner', 'Day 2: planning workshop', 'Day 3: team activity and return'])
            + f'<h2>Logistics</h2><p>Hotel booking closes two weeks before {d}. Contact person: {rng.choice(people(rng, 4))}.</p>')
    pid = f'offsite-{slug(city)}-{i + 1}'
    pads.append((pid, html)); facts[pid] = {'kind': 'offsite', 'title': title, 'city': city, 'date': d, 'people': n, 'budget': budget}

for pid, html in pads:
    call('createPad', padID=pid, text='')
    call('setHTML', padID=pid, html=f'<html><body>{html}</body></html>')
for pid in facts:
    facts[pid]['rev'] = call('getRevisionsCount', padID=pid)['revisions']
    facts[pid]['html'] = call('getHTML', padID=pid)['html']
json.dump(facts, open(f'{SNAP}/facts.json', 'w'), indent=1)
print('pads', len(pads))
