"""Seed NocoDB (tables.farm.test): super admin farmadmin@farm.test, 6 bases / 12 tables, ~1,400 rows, via the REST API.
Afterwards snapshot the DB as the template farm_nocodb_seed (see farm/nocodb/reset.sh).   python3 nocodb_seed.py <password>"""
import json, os, random, sys, requests
sys.path.insert(0, os.path.dirname(__file__))
from data_common import people, COMPANIES, PRODUCTS, CITIES, FIRST, LAST

PW = sys.argv[1]
B = 'http://127.0.0.1:7134'
rng = random.Random(5150)
s = requests.Session()
r = s.post(f'{B}/api/v1/auth/user/signup', json={'email': 'farmadmin@farm.test', 'password': PW})
if r.status_code >= 300:
    r = s.post(f'{B}/api/v1/auth/user/signin', json={'email': 'farmadmin@farm.test', 'password': PW})
tok = r.json()['token']; s.headers['xc-auth'] = tok


def ok(r):
    if r.status_code >= 300: raise RuntimeError(r.status_code, r.text[:400])
    return r.json()


for b in ok(s.get(f'{B}/api/v2/meta/bases'))['list']:
    ok(s.delete(f'{B}/api/v2/meta/bases/{b["id"]}'))


def base(title):
    return ok(s.post(f'{B}/api/v2/meta/bases', json={'title': title}))['id']


def table(bid, title, cols, rows):
    # An explicit ID column: without a primary key NocoDB makes the table read-only.
    columns = [{'column_name': 'id', 'title': 'Id', 'uidt': 'ID'}] + [{'column_name': c[0].lower().replace(' ', '_'), 'title': c[0], 'uidt': c[1], **({'dtxp': ','.join(f"'{o}'" for o in c[2])} if len(c) > 2 else {})} for c in cols]
    t = ok(s.post(f'{B}/api/v2/meta/bases/{bid}/tables', json={'table_name': title.lower().replace(' ', '_'), 'title': title, 'columns': columns}))
    for i in range(0, len(rows), 100):
        ok(s.post(f'{B}/api/v2/tables/{t["id"]}/records', json=rows[i:i + 100]))
    print(title, len(rows))
    return t['id']


def date(y=2026, m0=1, m1=12):
    return f'{y}-{rng.randint(m0, m1):02d}-{rng.randint(1, 28):02d}'


STAGES = ['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost']
SOURCES = ['Website', 'Referral', 'Event', 'Cold email', 'LinkedIn', 'Partner']

# 1. Sales CRM
bid = base('Sales CRM')
names = people(rng, 320)
table(bid, 'Leads', [('Name', 'SingleLineText'), ('Company', 'SingleLineText'), ('Email', 'Email'), ('City', 'SingleLineText'),
                     ('Stage', 'SingleSelect', STAGES), ('Source', 'SingleSelect', SOURCES), ('Deal Value', 'Number'), ('Next Follow-up', 'Date')],
      [{'Name': n, 'Company': rng.choice(COMPANIES), 'Email': n.lower().replace(' ', '.') + '@' + rng.choice(['mail', 'corp', 'work']) + '.test', 'City': rng.choice(CITIES),
        'Stage': rng.choice(STAGES), 'Source': rng.choice(SOURCES), 'Deal Value': rng.randrange(50, 5000) * 1000, 'Next Follow-up': date(2026, 10, 12)} for n in names[:300]])
table(bid, 'Accounts', [('Account', 'SingleLineText'), ('Industry', 'SingleSelect', ['Retail', 'Banking', 'Health', 'Media', 'Logistics', 'Tech']),
                        ('Owner', 'SingleLineText'), ('Annual Revenue', 'Number'), ('Employees', 'Number')],
      [{'Account': c, 'Industry': rng.choice(['Retail', 'Banking', 'Health', 'Media', 'Logistics', 'Tech']), 'Owner': rng.choice(names[300:]),
        'Annual Revenue': rng.randrange(10, 900) * 1000000, 'Employees': rng.randrange(20, 9000)} for c in COMPANIES])

# 2. Inventory
bid = base('Inventory')
sup = [f'{rng.choice(LAST)} {rng.choice(["Traders", "Supplies", "Distributors", "Imports", "Wholesale"])}' for _ in range(25)]
sup = list(dict.fromkeys(sup))
rows = []
for i in range(220):
    p = rng.choice(PRODUCTS)
    rows.append({'SKU': f'SKU-{10000 + i}', 'Product': f'{p} {rng.choice(["Pro", "Lite", "Max", "Mini", "Plus", "2026", "Basic", "XL"])}', 'Category': rng.choice(['Electronics', 'Furniture', 'Stationery', 'Pantry', 'Networking', 'Safety']),
                 'Supplier': rng.choice(sup), 'Stock': rng.randint(0, 600), 'Reorder Level': rng.choice([10, 20, 25, 50, 100]), 'Unit Price': rng.choice([49, 99, 199, 349, 599, 999, 1499, 2999, 7999, 15999])})
table(bid, 'Products', [('SKU', 'SingleLineText'), ('Product', 'SingleLineText'), ('Category', 'SingleSelect', ['Electronics', 'Furniture', 'Stationery', 'Pantry', 'Networking', 'Safety']),
                        ('Supplier', 'SingleLineText'), ('Stock', 'Number'), ('Reorder Level', 'Number'), ('Unit Price', 'Number')], rows)
table(bid, 'Suppliers', [('Supplier', 'SingleLineText'), ('City', 'SingleLineText'), ('Contact', 'SingleLineText'), ('Phone', 'PhoneNumber'), ('Rating', 'Number')],
      [{'Supplier': x, 'City': rng.choice(CITIES[:10]), 'Contact': rng.choice(names), 'Phone': f'+91 9{rng.randint(100000000, 999999999)}', 'Rating': rng.randint(1, 5)} for x in sup])

# 3. Content Calendar
bid = base('Content Calendar')
TOP = ['remote work', 'cloud costs', 'design systems', 'hiring', 'customer stories', 'product updates', 'security tips', 'AI at work', 'onboarding', 'pricing']
FORMS = ['How to', 'Why', 'A guide to', '5 lessons on', 'The future of', 'What we learned about', 'Checklist:']
writers = people(rng, 12)
used = set(); rows = []
while len(rows) < 160:
    t = f'{rng.choice(FORMS)} {rng.choice(TOP)}'
    if rng.random() < 0.5: t += f' ({rng.choice(["part 2", "for startups", "in 2026", "for teams", "explained"])})'
    if t in used: continue
    used.add(t)
    rows.append({'Title': t, 'Channel': rng.choice(['Blog', 'Newsletter', 'LinkedIn', 'YouTube', 'Podcast']), 'Status': rng.choice(['Idea', 'Drafting', 'In review', 'Scheduled', 'Published']),
                 'Writer': rng.choice(writers), 'Publish Date': date(2026, 7, 12), 'Word Count': rng.randrange(300, 3000, 50)})
table(bid, 'Posts', [('Title', 'SingleLineText'), ('Channel', 'SingleSelect', ['Blog', 'Newsletter', 'LinkedIn', 'YouTube', 'Podcast']),
                     ('Status', 'SingleSelect', ['Idea', 'Drafting', 'In review', 'Scheduled', 'Published']), ('Writer', 'SingleLineText'), ('Publish Date', 'Date'), ('Word Count', 'Number')], rows)
table(bid, 'Writers', [('Name', 'SingleLineText'), ('Email', 'Email'), ('Beat', 'SingleLineText'), ('Rate per Word', 'Decimal')],
      [{'Name': w, 'Email': w.lower().replace(' ', '.') + '@writers.test', 'Beat': rng.choice(TOP), 'Rate per Word': rng.choice([1.5, 2, 2.5, 3, 4])} for w in writers])

# 4. Hiring
bid = base('Hiring')
ROLES = ['Backend Engineer', 'Frontend Engineer', 'Product Designer', 'Data Analyst', 'QA Engineer', 'Product Manager', 'DevOps Engineer', 'Sales Executive', 'Support Lead', 'HR Generalist']
table(bid, 'Openings', [('Role', 'SingleLineText'), ('Team', 'SingleLineText'), ('Location', 'SingleLineText'), ('Openings', 'Number'), ('Hiring Manager', 'SingleLineText'), ('Status', 'SingleSelect', ['Open', 'On hold', 'Closed'])],
      [{'Role': r, 'Team': rng.choice(['Platform', 'Growth', 'Design', 'Data', 'Sales', 'People']), 'Location': rng.choice(['Pune', 'Bengaluru', 'Remote', 'Mumbai']), 'Openings': rng.randint(1, 4),
        'Hiring Manager': rng.choice(names), 'Status': rng.choice(['Open', 'Open', 'On hold', 'Closed'])} for r in ROLES])
cands = people(rng, 200)
table(bid, 'Candidates', [('Name', 'SingleLineText'), ('Role', 'SingleLineText'), ('Stage', 'SingleSelect', ['Applied', 'Screen', 'Interview', 'Offer', 'Hired', 'Rejected']),
                          ('Experience (years)', 'Number'), ('Expected CTC', 'Number'), ('Applied On', 'Date'), ('Email', 'Email')],
      [{'Name': c, 'Role': rng.choice(ROLES), 'Stage': rng.choice(['Applied', 'Screen', 'Interview', 'Offer', 'Hired', 'Rejected']), 'Experience (years)': rng.randint(0, 15),
        'Expected CTC': rng.randrange(4, 60) * 100000, 'Applied On': date(2026, 6, 10), 'Email': c.lower().replace(' ', '.') + '@candidates.test'} for c in cands[:180]])

# 5. Projects
bid = base('Projects')
VERBS = ['Set up', 'Review', 'Migrate', 'Write', 'Test', 'Design', 'Fix', 'Plan', 'Ship', 'Document']
OBJ = ['billing page', 'login flow', 'CI runners', 'search index', 'release notes', 'mobile build', 'data export', 'admin roles', 'audit logs', 'status page', 'onboarding emails', 'API docs']
used = set(); rows = []
while len(rows) < 240:
    t = f'{rng.choice(VERBS)} {rng.choice(OBJ)}'
    if rng.random() < 0.6: t += f' for {rng.choice(["v2", "EU customers", "the beta", "enterprise", "Q4", "mobile"])}'
    if t in used: continue
    used.add(t)
    rows.append({'Task': t, 'Project': rng.choice(['Atlas', 'Beacon', 'Comet', 'Delta', 'Ember']), 'Assignee': rng.choice(writers + names[:20]),
                 'Status': rng.choice(['To do', 'In progress', 'Blocked', 'Done']), 'Priority': rng.choice(['Low', 'Medium', 'High', 'Urgent']), 'Due Date': date(2026, 10, 12), 'Estimate (h)': rng.choice([1, 2, 3, 5, 8, 13])})
table(bid, 'Tasks', [('Task', 'SingleLineText'), ('Project', 'SingleSelect', ['Atlas', 'Beacon', 'Comet', 'Delta', 'Ember']), ('Assignee', 'SingleLineText'),
                     ('Status', 'SingleSelect', ['To do', 'In progress', 'Blocked', 'Done']), ('Priority', 'SingleSelect', ['Low', 'Medium', 'High', 'Urgent']), ('Due Date', 'Date'), ('Estimate (h)', 'Number')], rows)
table(bid, 'Milestones', [('Milestone', 'SingleLineText'), ('Project', 'SingleLineText'), ('Target Date', 'Date'), ('Done', 'Checkbox')],
      [{'Milestone': f'{p} {m}', 'Project': p, 'Target Date': date(2026, 9, 12), 'Done': rng.random() < 0.3} for p in ['Atlas', 'Beacon', 'Comet', 'Delta', 'Ember'] for m in ['alpha', 'beta', 'GA', 'retro']])

# 6. Events
bid = base('Events')
evs = [f'{rng.choice(["Product", "Customer", "Partner", "Team", "Developer"])} {rng.choice(["Meetup", "Summit", "Workshop", "Webinar", "Day"])} {c}' for c in CITIES]
evs = list(dict.fromkeys(evs))
table(bid, 'Events', [('Event', 'SingleLineText'), ('City', 'SingleLineText'), ('Date', 'Date'), ('Capacity', 'Number'), ('Budget', 'Number')],
      [{'Event': e, 'City': e.split()[-1], 'Date': date(2026, 10, 12), 'Capacity': rng.choice([30, 50, 80, 120, 200]), 'Budget': rng.randrange(50, 900) * 1000} for e in evs])
att = people(rng, 260)
table(bid, 'Attendees', [('Name', 'SingleLineText'), ('Event', 'SingleLineText'), ('Company', 'SingleLineText'), ('Ticket', 'SingleSelect', ['Free', 'Standard', 'VIP', 'Speaker']), ('Checked In', 'Checkbox')],
      [{'Name': a, 'Event': rng.choice(evs), 'Company': rng.choice(COMPANIES), 'Ticket': rng.choice(['Free', 'Standard', 'Standard', 'VIP', 'Speaker']), 'Checked In': rng.random() < 0.4} for a in att[:240]])
print('done')
