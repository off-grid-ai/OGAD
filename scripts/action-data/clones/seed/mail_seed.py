#!/usr/bin/env python3
"""Synthetic mailboxes for the clone farm (no real people, no real addresses).

  python3 mail_seed.py --out /workspace/clone-farm/snap/mail --passwd /workspace/clone-farm/mail/users.passwd

Writes Maildir++ trees <out>/<domain>/<user>/Maildir and a dovecot passwd-file. Every account
uses the farm test password from clones/farm/accounts.json. The main persona gets ~450 messages:
newsletters, invoices (paid and unpaid), team threads, HR, travel, receipts, social notifications.
"""
import argparse, json, os, random, time, email.utils
from email.message import EmailMessage
from datetime import datetime, timedelta, timezone

R = random.Random(20261016)
HERE = os.path.dirname(os.path.abspath(__file__))
ACCOUNTS = json.load(open(os.path.join(HERE, '..', 'farm', 'accounts.json')))
PASSWORD = ACCOUNTS['password']

FIRST = ['Asha', 'Rohan', 'Meera', 'Kabir', 'Priya', 'Arjun', 'Neha', 'Vikram', 'Isha', 'Dev', 'Ananya', 'Karan', 'Tara', 'Nikhil', 'Sana', 'Rahul',
         'Leela', 'Aditya', 'Zoya', 'Farhan', 'Diya', 'Omar', 'Ritu', 'Samir', 'Pooja', 'Varun', 'Kavya', 'Imran', 'Nisha', 'Yash', 'Maya', 'Tenzin',
         'Elena', 'Lucas', 'Hana', 'Mateo', 'Grace', 'Noah', 'Amara', 'Felix']
LAST = ['Rao', 'Mehta', 'Iyer', 'Khan', 'Nair', 'Sharma', 'Das', 'Kapoor', 'Joshi', 'Bose', 'Pillai', 'Singh', 'Menon', 'Reddy', 'Gupta', 'Ali',
        'Fernandes', 'Chatterjee', 'Kulkarni', 'Banerjee', 'Shah', 'Verma', 'Patel', 'Rossi', 'Silva', 'Tanaka', 'Okafor', 'Novak', 'Berg', 'Moreau']
DOMAIN = 'farm.test'
VENDOR_DOMAINS = ['northwind.test', 'acmepay.test', 'brightdesk.test', 'skyroute.test', 'greenleaf.test', 'pixelforge.test']

NEWSLETTERS = [
    ('The Morning Byte', 'news@morningbyte.test', ['AI chips get cheaper', 'Five tools for remote teams', 'Why batteries matter', 'The week in startups', 'Cloud bills explained', 'Open source wins again']),
    ('Weekend Reads', 'hello@weekendreads.test', ['10 long reads for Sunday', 'A history of the pencil', 'How cities cool down', 'The slow travel issue']),
    ('Market Pulse', 'digest@marketpulse.test', ['Sensex closes higher', 'Rupee steady on oil', 'IPO watch: three to track', 'Gold at a monthly high']),
    ('Cook Smart', 'recipes@cooksmart.test', ['Five dals in 20 minutes', 'Monsoon snacks', 'One-pot biryani', 'Meal prep for the week']),
    ('DevOps Weekly', 'issues@devopsweekly.test', ['Kubernetes 1.34 notes', 'Postgres tuning tips', 'Incident review templates', 'Terraform at scale']),
]
PROJECTS = ['Atlas launch', 'Q4 budget', 'Mobile app redesign', 'Vendor onboarding', 'Data migration', 'Hiring plan', 'Customer offsite', 'Security audit']
CITIES = ['Pune', 'Bengaluru', 'Mumbai', 'Delhi', 'Hyderabad', 'Chennai', 'Goa', 'Jaipur']


def person(i):
    first, last = FIRST[i % len(FIRST)], LAST[(i * 7) % len(LAST)]
    return {'name': f'{first} {last}', 'first': first, 'email': f'{first.lower()}.{last.lower()}@{DOMAIN}'}


PEOPLE = [person(i) for i in range(40)]
ME = PEOPLE[0]
# Two rich mailboxes: one per webmail app, so Roundcube and SnappyMail runs never touch each other's state.
MAIN = PEOPLE[:2]


class Box:
    def __init__(self, root, owner):
        self.root, self.owner, self.n = root, owner, 0
        for f in ['', '.Sent', '.Drafts', '.Trash', '.Junk', '.Archive', '.Receipts', '.Travel', '.Projects']:
            for sub in ['cur', 'new', 'tmp']:
                os.makedirs(os.path.join(root, f, sub), exist_ok=True)

    def put(self, msg, folder='', seen=True, flagged=False, draft=False):
        self.n += 1
        flags = ''.join(sorted(('D' if draft else '') + ('F' if flagged else '') + ('S' if seen else '')))
        ts = int(email.utils.parsedate_to_datetime(msg['Date']).timestamp())
        name = f'{ts}.M{self.n}P1.farm:2,{flags}'
        path = os.path.join(self.root, folder, 'cur', name)
        with open(path, 'wb') as f:
            f.write(bytes(msg))
        os.utime(path, (ts, ts))


NOW = datetime(2026, 10, 16, 18, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))


def when(days_ago, hour=None):
    d = NOW - timedelta(days=days_ago, hours=0 if hour is not None else R.randint(0, 10), minutes=R.randint(0, 59))
    if hour is not None:
        d = d.replace(hour=hour)
    return d


def mail(frm, to, subject, body, date, reply_to=None, cc=None, msgid=None):
    m = EmailMessage()
    m['From'] = email.utils.formataddr((frm['name'], frm['email']))
    m['To'] = ', '.join(email.utils.formataddr((t['name'], t['email'])) for t in to)
    if cc:
        m['Cc'] = ', '.join(email.utils.formataddr((t['name'], t['email'])) for t in cc)
    m['Subject'] = subject
    m['Date'] = email.utils.format_datetime(date)
    m['Message-ID'] = msgid or email.utils.make_msgid(domain=DOMAIN)
    if reply_to:
        m['In-Reply-To'] = reply_to
        m['References'] = reply_to
    m.set_content(body)
    return m


def sign(p):
    return f'\n\nThanks,\n{p["first"]}'


def seed_main(box, me):
    # Newsletters: many issues, a list-unsubscribe header like real ones.
    for name, addr, topics in NEWSLETTERS:
        sender = {'name': name, 'email': addr}
        for k in range(R.randint(8, 14)):
            t = R.choice(topics)
            m = mail(sender, [me], f'{name}: {t}', f'Hi {me["first"]},\n\nThis week: {t}.\n\n' + '\n'.join(f'- Story {j + 1}: {R.choice(topics)}' for j in range(4)) + f'\n\nYou get this mail because you subscribed to {name}.\nUnsubscribe: https://{addr.split("@")[1]}/unsubscribe', when(k * 4 + R.randint(0, 3)))
            m['List-Unsubscribe'] = f'<mailto:unsubscribe@{addr.split("@")[1]}>'
            box.put(m, seen=R.random() < 0.6)
    # Invoices: some paid, some unpaid, from vendors.
    for k in range(18):
        v = R.choice(VENDOR_DOMAINS)
        vendor = {'name': v.split('.')[0].capitalize() + ' Billing', 'email': f'billing@{v}'}
        num = 4100 + k * 7
        amount = R.choice([4500, 12800, 2399, 56000, 8750, 19999, 31250, 999])
        unpaid = k % 3 != 0
        due = (NOW - timedelta(days=R.randint(-20, 25))).strftime('%d %b %Y')
        status = 'is due' if unpaid else 'has been paid. Thank you'
        box.put(mail(vendor, [me], f'Invoice INV-{num} from {vendor["name"].split()[0]}', f'Hello {me["first"]},\n\nInvoice INV-{num} for Rs {amount:,} {status}.\nDue date: {due}.\n\nRegards,\n{vendor["name"]}', when(k * 3 + 1)), seen=R.random() < 0.5, flagged=unpaid and R.random() < 0.3)
    # Team threads with replies.
    for k in range(70):
        p = R.choice([x for x in PEOPLE[1:25] if x is not me])
        proj = R.choice(PROJECTS)
        subj = R.choice([f'{proj}: status update', f'Quick question about {proj}', f'{proj} review on {R.choice(["Monday", "Tuesday", "Thursday", "Friday"])}', f'Notes from the {proj} call', f'Draft plan for {proj}'])
        d = when(R.randint(0, 50))
        first = mail(p, [me], subj, f'Hi {me["first"]},\n\n' + R.choice([f'Can you share the latest numbers for {proj}?', f'I updated the doc for {proj}. Please take a look before the review.', f'The {proj} timeline moved by a week. Is that okay with you?', f'Could we meet tomorrow at {R.randint(10, 17)}:00 to discuss {proj}?']) + sign(p), d)
        box.put(first, folder='.Projects' if R.random() < 0.15 else '', seen=R.random() < 0.7, flagged=R.random() < 0.08)
        if R.random() < 0.45:
            reply = mail(me, [p], 'Re: ' + subj, f'Hi {p["first"]},\n\nSure, I will send it by end of day.\n\n{me["first"]}', d + timedelta(hours=2), reply_to=first['Message-ID'])
            box.put(reply, folder='.Sent')
            if R.random() < 0.5:
                box.put(mail(p, [me], 'Re: ' + subj, f'Great, thank you!{sign(p)}', d + timedelta(hours=5), reply_to=reply['Message-ID']), seen=R.random() < 0.5)
    # HR, IT, receipts, travel, social notifications.
    hr = {'name': 'People Team', 'email': f'people@{DOMAIN}'}
    for s in ['Holiday calendar for 2027', 'Update your emergency contact', 'Diwali party: RSVP by Friday', 'New leave policy', 'Benefits enrolment closes soon', 'Welcome our new joiners']:
        box.put(mail(hr, [me], s, f'Hi all,\n\n{s}. Details are on the intranet.\n\nPeople Team', when(R.randint(0, 45))), seen=R.random() < 0.5)
    it = {'name': 'IT Helpdesk', 'email': f'it@{DOMAIN}'}
    for s in ['Password expires in 7 days', 'Laptop refresh: pick a slot', 'Scheduled VPN maintenance', 'Ticket #8812 resolved']:
        box.put(mail(it, [me], s, f'Hello,\n\n{s}.\n\nIT Helpdesk', when(R.randint(0, 40))), seen=R.random() < 0.6)
    shops = [('Northwind Store', 'orders@northwind.test'), ('GreenLeaf Grocers', 'orders@greenleaf.test'), ('PixelForge', 'store@pixelforge.test')]
    for k in range(20):
        n, a = R.choice(shops)
        item = R.choice(['wireless mouse', 'yoga mat', 'coffee beans 1kg', 'USB-C hub', 'desk lamp', 'notebook set', 'water bottle', 'running shoes'])
        box.put(mail({'name': n, 'email': a}, [me], f'Your order #{70000 + k * 13} has shipped', f'Hi {me["first"]},\n\nYour {item} is on the way. Expected delivery: {(NOW + timedelta(days=R.randint(1, 5))).strftime("%d %b")}.\n\n{n}', when(R.randint(0, 55))), folder='.Receipts' if R.random() < 0.5 else '', seen=R.random() < 0.8)
    air = {'name': 'SkyRoute Airlines', 'email': 'trips@skyroute.test'}
    for k in range(8):
        c1, c2 = R.sample(CITIES, 2)
        box.put(mail(air, [me], f'Booking confirmed: {c1} to {c2}', f'Dear {me["name"]},\n\nYour flight from {c1} to {c2} on {(NOW + timedelta(days=R.randint(3, 60))).strftime("%d %b %Y")} is confirmed. PNR: {R.choice("ABCDEFGHJK")}{R.randint(10000, 99999)}.\n\nSkyRoute', when(R.randint(0, 60))), folder='.Travel' if R.random() < 0.6 else '', seen=True)
    social = {'name': 'Chirp', 'email': 'notify@chirp.test'}
    for k in range(25):
        p = R.choice([x for x in PEOPLE[1:] if x is not me])
        box.put(mail(social, [me], R.choice([f'{p["name"]} mentioned you', f'{p["name"]} liked your post', f'You have a new follower: {p["name"]}']), 'See it on Chirp.', when(R.randint(0, 30))), seen=R.random() < 0.4)
    for k in range(6):
        box.put(mail({'name': 'Prize Desk', 'email': 'winner@lucky-prize.test'}, [me], 'You won a free phone!!!', 'Click here to claim.', when(R.randint(0, 30))), folder='.Junk')
    # Drafts and archive.
    for k in range(3):
        p = R.choice([x for x in PEOPLE[1:20] if x is not me])
        box.put(mail(me, [p], f'Draft: {R.choice(PROJECTS)} follow-up', f'Hi {p["first"]},\n\n', when(R.randint(0, 10))), folder='.Drafts', draft=True)
    for k in range(40):
        p = R.choice([x for x in PEOPLE[1:] if x is not me])
        box.put(mail(p, [me], f'Old: {R.choice(PROJECTS)} notes', f'Archived notes.{sign(p)}', when(R.randint(60, 200))), folder='.Archive')


def seed_other(box, me):
    for k in range(R.randint(15, 40)):
        p = R.choice([x for x in PEOPLE if x is not me])
        box.put(mail(p, [me], f'{R.choice(PROJECTS)}: {R.choice(["next steps", "question", "update", "files"])}', f'Hi {me["first"]},\n\nSee the latest on this.{sign(p)}', when(R.randint(0, 60))), seen=R.random() < 0.6)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--passwd', required=True)
    a = ap.parse_args()
    lines = []
    extra = [{'name': d.split('.')[0].capitalize() + ' Billing', 'email': f'billing@{d}'} for d in VENDOR_DOMAINS]
    for p in PEOPLE + extra:
        user, dom = p['email'].split('@')
        box = Box(os.path.join(a.out, dom, user, 'Maildir'), p)
        (seed_main if p in MAIN else seed_other)(box, p) if p in PEOPLE else None
        lines.append(f'{p["email"]}:{{PLAIN}}{PASSWORD}::::::')
        print(p['email'], box.n)
    with open(a.passwd, 'w') as f:
        f.write('\n'.join(lines) + '\n')
    json.dump({'main': ME, 'people': PEOPLE, 'vendors': extra}, open(os.path.join(a.out, 'people.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
