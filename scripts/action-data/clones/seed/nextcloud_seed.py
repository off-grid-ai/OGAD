#!/usr/bin/env python3
"""Synthetic Nextcloud workspace for the clone farm (cloud.farm.test). No real people, no real data.

  python3 nextcloud_seed.py            # after farm/nextcloud/install.sh, before farm/nextcloud/snapshot.sh

Same people as mail_seed.py (asha.rao is the main persona). Seeds:
- 30 users in 6 groups (provisioning API)
- Asha's drive: Finance, Projects, HR, Marketing, Photos, Documents, Notes, Templates, Archive (~200 files:
  md/txt/csv/xlsx/pdf/jpg/png), written into the data dir then `occ files:scan`; a few files for every colleague
- shares both ways (OCS), favorites (WebDAV PROPPATCH)
- ~90 calendar events over +-2 months (CalDAV), ~55 contacts (CardDAV)
- 3 Deck boards with stacks, labels, ~65 cards with due dates, assignees and comments (Deck API)
"""
import io, json, os, random, struct, subprocess, uuid, zipfile, zlib
from datetime import datetime, timedelta, timezone, date
import requests
from PIL import Image, ImageDraw

R = random.Random(20261016)
HERE = os.path.dirname(os.path.abspath(__file__))
PASSWORD = json.load(open(os.path.join(HERE, '..', 'farm', 'accounts.json')))['password']
BASE = 'http://cloud.farm.test'
WWW = '/dev/shm/clone-farm/nextcloud/www'
DATA = '/dev/shm/clone-farm/nextcloud/data'
IST = timezone(timedelta(hours=5, minutes=30))
TODAY = date(2026, 10, 16)

FIRST = ['Asha', 'Rohan', 'Meera', 'Kabir', 'Priya', 'Arjun', 'Neha', 'Vikram', 'Isha', 'Dev', 'Ananya', 'Karan', 'Tara', 'Nikhil', 'Sana', 'Rahul',
         'Leela', 'Aditya', 'Zoya', 'Farhan', 'Diya', 'Omar', 'Ritu', 'Samir', 'Pooja', 'Varun', 'Kavya', 'Imran', 'Nisha', 'Yash', 'Maya', 'Tenzin',
         'Elena', 'Lucas', 'Hana', 'Mateo', 'Grace', 'Noah', 'Amara', 'Felix']
LAST = ['Rao', 'Mehta', 'Iyer', 'Khan', 'Nair', 'Sharma', 'Das', 'Kapoor', 'Joshi', 'Bose', 'Pillai', 'Singh', 'Menon', 'Reddy', 'Gupta', 'Ali',
        'Fernandes', 'Chatterjee', 'Kulkarni', 'Banerjee', 'Shah', 'Verma', 'Patel', 'Rossi', 'Silva', 'Tanaka', 'Okafor', 'Novak', 'Berg', 'Moreau']
GROUPS = ['Leadership', 'Engineering', 'Finance', 'HR', 'Sales', 'Marketing']


def person(i):
    first, last = FIRST[i % len(FIRST)], LAST[(i * 7) % len(LAST)]
    return {'uid': f'{first.lower()}.{last.lower()}', 'name': f'{first} {last}', 'first': first, 'email': f'{first.lower()}.{last.lower()}@farm.test',
            'group': GROUPS[i % len(GROUPS)]}


PEOPLE = [person(i) for i in range(30)]
ME = PEOPLE[0]
OTHERS = PEOPLE[1:]
S = requests.Session()
# No cookies: a Nextcloud session cookie would override Basic auth and act as the previous user.
from http.cookiejar import DefaultCookiePolicy
S.cookies.set_policy(DefaultCookiePolicy(allowed_domains=[]))


def auth(uid):
    return (uid, PASSWORD) if uid != 'farmadmin' else ('farmadmin', PASSWORD)


def ocs(method, path, uid='farmadmin', **kw):
    r = S.request(method, BASE + path, auth=auth(uid), headers={'OCS-APIRequest': 'true', 'Accept': 'application/json'}, **kw)
    return r


def occ(*args):
    return subprocess.run(['php', 'occ', *args], cwd=WWW, capture_output=True, text=True).stdout


# ---------- users ----------
def make_users():
    for g in GROUPS:
        ocs('POST', '/ocs/v2.php/cloud/groups', data={'groupid': g})
    for p in PEOPLE:
        r = ocs('POST', '/ocs/v2.php/cloud/users', data={'userid': p['uid'], 'password': PASSWORD, 'displayName': p['name'], 'email': p['email'], 'groups[]': [p['group']]})
        if r.status_code not in (200,) and 'already exists' not in r.text:
            print('user', p['uid'], r.status_code, r.text[:200])
        # First DAV access sets up the home, the default calendar and address book.
        S.request('PROPFIND', f"{BASE}/remote.php/dav/files/{p['uid']}/", auth=auth(p['uid']), headers={'Depth': '0'})
    occ('user:setting', ME['uid'], 'core', 'timezone', 'Asia/Kolkata')
    occ('user:setting', ME['uid'], 'settings', 'phone', '+91 98200 11223')
    occ('user:setting', ME['uid'], 'core', 'lang', 'en')
    occ('user:setting', ME['uid'], 'core', 'locale', 'en_IN')
    occ('user:setting', ME['uid'], 'calendar', 'timezone', 'Asia/Kolkata')


# ---------- file generators ----------
def xlsx(rows, sheet='Sheet1'):
    def cell(ref, v):
        if isinstance(v, (int, float)):
            return f'<c r="{ref}"><v>{v}</v></c>'
        v = str(v).replace('&', '&amp;').replace('<', '&lt;')
        return f'<c r="{ref}" t="inlineStr"><is><t>{v}</t></is></c>'
    cols = 'ABCDEFGHIJKLMNOP'
    body = ''.join(f'<row r="{i + 1}">' + ''.join(cell(f'{cols[j]}{i + 1}', v) for j, v in enumerate(r)) + '</row>' for i, r in enumerate(rows))
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr('xl/workbook.xml', f'<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="{sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml', f'<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>{body}</sheetData></worksheet>')
    return b.getvalue()


def pdf(lines):
    text = 'BT /F1 12 Tf 60 780 Td 16 TL ' + ' '.join('(' + l.replace('\\', '\\\\').replace('(', '\\(').replace(')', '\\)') + ") '" for l in lines) + ' ET'
    objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
            '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', f'<< /Length {len(text)} >>\nstream\n{text}\nendstream']
    out = b'%PDF-1.4\n'
    offs = []
    for i, o in enumerate(objs):
        offs.append(len(out))
        out += f'{i + 1} 0 obj\n{o}\nendobj\n'.encode('latin-1')
    x = len(out)
    out += f'xref\n0 {len(objs) + 1}\n0000000000 65535 f \n'.encode() + b''.join(f'{o:010d} 00000 n \n'.encode() for o in offs)
    out += f'trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{x}\n%%EOF\n'.encode()
    return out


def image(label, fmt='JPEG', size=(960, 640)):
    c1 = tuple(R.randint(40, 200) for _ in range(3)); c2 = tuple(R.randint(40, 220) for _ in range(3))
    im = Image.new('RGB', size, c1)
    d = ImageDraw.Draw(im)
    for i in range(12):
        x, y = R.randint(0, size[0]), R.randint(0, size[1]); r = R.randint(30, 160)
        d.ellipse([x - r, y - r, x + r, y + r], fill=tuple(min(255, a + R.randint(-30, 30)) for a in c2))
    d.rectangle([0, size[1] - 60, size[0], size[1]], fill=(20, 20, 20))
    d.text((20, size[1] - 40), label, fill=(240, 240, 240))
    b = io.BytesIO(); im.save(b, fmt, quality=80); return b.getvalue()


def csv(rows):
    return '\n'.join(','.join(f'"{c}"' if ',' in str(c) else str(c) for c in r) for r in rows) + '\n'


def ago(days):
    return datetime.combine(TODAY - timedelta(days=days), datetime.min.time(), IST) + timedelta(hours=R.randint(9, 19), minutes=R.randint(0, 59))


# ---------- Asha's drive ----------
PROJECTS = {
    'Atlas launch': ('the Atlas customer portal', 'Rohan Kapoor', 'November 28'),
    'Mobile app redesign': ('the new mobile app navigation and onboarding', 'Kabir Verma', 'December 12'),
    'Data migration': ('moving billing data from the legacy Oracle system to Postgres', 'Vikram Banerjee', 'November 14'),
    'Security audit': ('the ISO 27001 surveillance audit', 'Dev Khan', 'October 30'),
    'Customer offsite': ('the two-day customer offsite in Goa', 'Neha Menon', 'December 4'),
}
VENDORS = ['Northwind Traders', 'AcmePay', 'BrightDesk', 'SkyRoute Travels', 'Greenleaf Catering', 'PixelForge Studio', 'Cloudnine Hosting', 'Inkwell Printers']
CANDIDATES = ['Aarav Malhotra', 'Sneha Pillai', 'Jonas Weber', 'Ritika Sen', 'Mohit Bansal', 'Chloe Martin', 'Irfan Qureshi']


def drive_files():
    f = {}  # path -> (bytes|str, days_ago)
    def add(path, content, days=None):
        f[path] = (content, R.randint(1, 120) if days is None else days)
    # Root
    add('Readme.md', f"# Asha's drive\n\nWork files for Operations. Finance is shared with the finance group; Projects holds one folder per project.\n\n- Ask Rohan before editing Atlas files\n- Photos from the Goa offsite are in Photos/Offsite Goa\n", 90)
    add('Todo.txt', "- Send Q4 budget to Ritu\n- Book Pune travel for 3 Nov\n- Review Atlas launch checklist\n- Renew BrightDesk contract\n- Interview feedback for Jonas Weber\n", 2)
    add('Quarterly OKRs.md', "# Q4 2026 OKRs\n\n## Objective 1: Launch Atlas to all enterprise customers\n- KR1: 40 customers live by 15 December\n- KR2: Support tickets per customer below 3\n\n## Objective 2: Cut cloud spend\n- KR1: Spend down 18% vs Q3\n- KR2: Move billing data off Oracle\n\n## Objective 3: Hire well\n- KR1: 6 engineers and 2 designers joined\n", 20)
    # Finance
    months = ['April', 'May', 'June', 'July', 'August', 'September']
    for i, m in enumerate(months):
        rows = [['Date', 'Category', 'Description', 'Amount (INR)', 'Approved by']]
        for _ in range(R.randint(8, 14)):
            rows.append([f'2026-{4 + i:02d}-{R.randint(1, 28):02d}', R.choice(['Travel', 'Meals', 'Software', 'Hardware', 'Training', 'Office']),
                         R.choice(['Cab to airport', 'Team lunch', 'Figma seats', 'USB-C hub', 'AWS course', 'Printer paper', 'Hotel Pune', 'Client dinner']),
                         R.randint(4, 300) * 50, R.choice(['Ritu Nair', 'Meera Gupta', 'Rohan Kapoor'])])
        add(f'Finance/Expenses/Expense report {m} 2026.csv', csv(rows), 170 - i * 30)
    for n in range(1, 15):
        v = VENDORS[n % len(VENDORS)]; amt = R.randint(20, 900) * 100
        add(f'Finance/Invoices/INV-2026-{n:03d} {v}.pdf', pdf([f'INVOICE INV-2026-{n:03d}', f'From: {v}', 'To: Farm Test Pvt Ltd, Pune', f'Date: 2026-{min(10, 3 + n // 2):02d}-{R.randint(1, 28):02d}',
                                                              f'Amount due: INR {amt:,}', f'Status: {"Paid" if n < 11 else "Unpaid"}', 'Payment terms: 30 days']), 150 - n * 10)
    add('Finance/Budget Q4 2026.xlsx', xlsx([['Team', 'Q3 actual', 'Q4 budget', 'Change %'], ['Engineering', 4200000, 4550000, 8.3], ['Marketing', 1800000, 2100000, 16.7],
                                             ['Sales', 2500000, 2450000, -2.0], ['HR', 600000, 640000, 6.7], ['Operations', 950000, 900000, -5.3], ['Total', 10050000, 10640000, 5.9]], 'Q4'), 12)
    add('Finance/Budget notes.md', "# Q4 budget notes\n\n- Marketing asks for 21 lakh because of the Atlas launch campaign.\n- Sales budget drops: two open roles moved to Q1.\n- Cloud spend target: down 18%. Vikram owns the plan.\n- Ritu needs the final sheet by 24 October.\n", 9)
    add('Finance/Vendor payments.csv', csv([['Vendor', 'Invoice', 'Amount (INR)', 'Due date', 'Status']] + [[VENDORS[n % 8], f'INV-2026-{n:03d}', R.randint(20, 900) * 100, f'2026-{min(12, 4 + n // 2):02d}-15', 'Paid' if n < 11 else 'Unpaid'] for n in range(1, 15)]), 6)
    add('Finance/Tax/Form 16 FY2025-26.pdf', pdf(['FORM 16 (Part B)', 'Employee: Asha Rao', 'Assessment year 2026-27', 'Gross salary: INR 28,40,000', 'Tax deducted: INR 5,12,300']), 140)
    add('Finance/Tax/Investment declaration.md', "# Investment declaration FY2026-27\n\n| Section | Item | Amount |\n|---|---|---|\n| 80C | PPF | 1,50,000 |\n| 80D | Health insurance | 25,000 |\n| HRA | Rent, Pune | 3,60,000 |\n", 100)
    add('Finance/Cloud spend by month.xlsx', xlsx([['Month', 'AWS', 'GCP', 'Total']] + [[m, R.randint(800, 1300) * 1000, R.randint(100, 300) * 1000, 0] for m in months], 'Spend'), 15)
    add('Finance/Reimbursement policy.txt', "Claims must be filed within 30 days.\nMeals up to INR 1,500 per person.\nAirport cabs are always reimbursed.\nAttach the receipt as a PDF or photo.\n", 200)
    # Projects
    for name, (what, owner, due) in PROJECTS.items():
        base = f'Projects/{name}'
        add(f'{base}/Brief.md', f"# {name}: project brief\n\n**Goal:** {what}.\n**Owner:** {owner}\n**Target date:** {due}\n\n## Scope\n- Discovery and plan\n- Build and test\n- Rollout and review\n\n## Out of scope\n- Pricing changes\n", R.randint(40, 90))
        for k, d in enumerate([R.randint(30, 60), R.randint(10, 29), R.randint(1, 9)]):
            dt = TODAY - timedelta(days=d)
            add(f'{base}/Meeting notes {dt.isoformat()}.md', f"# {name} sync, {dt.strftime('%d %B %Y')}\n\nAttendees: Asha Rao, {owner}, {R.choice(OTHERS)['name']}\n\n## Decisions\n- {R.choice(['Keep the launch date', 'Move QA to week 2', 'Add a rollback plan', 'Drop the beta flag'])}\n\n## Actions\n- {owner.split()[0]}: {R.choice(['share the test plan', 'update the timeline', 'confirm vendor quote', 'fix the open bugs'])} by Friday\n- Asha: {R.choice(['review the budget', 'tell the leadership group', 'book the room', 'sign the PO'])}\n", d)
        add(f'{base}/Timeline.csv', csv([['Milestone', 'Owner', 'Date', 'Status'], ['Kickoff', owner, '2026-08-04', 'Done'], ['Design sign-off', 'Asha Rao', '2026-09-12', 'Done'],
                                          ['Build complete', owner, '2026-10-24', 'In progress'], ['Go live', owner, due, 'Planned']]), R.randint(5, 40))
        add(f'{base}/Risks.md', f"# Risks: {name}\n\n1. {R.choice(['Vendor delay', 'Key person on leave', 'Data quality', 'Budget cut'])}: medium\n2. {R.choice(['Scope creep', 'Late test data', 'Security review backlog'])}: high\n3. Holiday season slows approvals: low\n", R.randint(5, 60))
        add(f'{base}/Status update.txt', f"{name} status: {R.choice(['on track', 'at risk', 'on track', 'slightly behind'])}.\nNext milestone: build complete on 24 October.\nOwner: {owner}.\n", R.randint(1, 8))
        add(f'{base}/Stakeholders.xlsx', xlsx([['Name', 'Role', 'Email']] + [[p['name'], p['group'], p['email']] for p in R.sample(OTHERS, 5)], 'People'), R.randint(30, 80))
    add('Projects/Atlas launch/Launch checklist.md', "# Atlas launch checklist\n\n- [x] Pricing page live\n- [x] SSO tested with 3 customers\n- [ ] Support runbook\n- [ ] Status page\n- [ ] Announcement email\n", 3)
    add('Projects/Atlas launch/Architecture.png', image('Atlas architecture', 'PNG'), 25)
    add('Projects/Security audit/Audit findings 2025.pdf', pdf(['Surveillance audit 2025: findings', '1. Access reviews late (minor)', '2. Backup restore test missing (minor)', '3. No major findings']), 300)
    add('Projects/Data migration/Table mapping.csv', csv([['Oracle table', 'Postgres table', 'Rows', 'Done']] + [[f'BILL_{t}', f'billing.{t.lower()}', R.randint(1000, 900000), R.choice(['yes', 'no'])] for t in ['INVOICE', 'LINE', 'CUSTOMER', 'PAYMENT', 'TAX', 'CREDIT_NOTE']]), 11)
    # HR
    add('HR/Hiring plan 2026.md', "# Hiring plan 2026\n\n| Role | Count | Status |\n|---|---|---|\n| Backend engineer | 3 | 2 offers out |\n| Frontend engineer | 2 | interviewing |\n| Product designer | 2 | 1 joined |\n| Support lead | 1 | sourcing |\n", 25)
    for c in CANDIDATES:
        add(f'HR/Interview feedback/{c}.md', f"# Interview: {c}\n\nRole: {R.choice(['Backend engineer', 'Frontend engineer', 'Product designer'])}\nPanel: Asha Rao, {R.choice(OTHERS)['name']}\n\n- Problem solving: {R.randint(2, 5)}/5\n- Communication: {R.randint(2, 5)}/5\n- Recommendation: {R.choice(['Hire', 'Hire', 'No hire', 'Second round'])}\n", R.randint(3, 50))
    add('HR/Leave policy.md', "# Leave policy\n\n- 24 days paid leave per year\n- 12 public holidays\n- Up to 5 days carry forward\n- Apply in the HR portal 2 weeks ahead\n", 280)
    add('HR/Onboarding checklist.md', "# Onboarding checklist\n\n1. Laptop and accounts on day 1\n2. Buddy assigned\n3. Security training in week 1\n4. 30-60-90 day plan with manager\n", 120)
    add('HR/Team roster.xlsx', xlsx([['Name', 'Team', 'Email', 'Location']] + [[p['name'], p['group'], p['email'], R.choice(['Pune', 'Bengaluru', 'Mumbai', 'Remote'])] for p in PEOPLE], 'Roster'), 30)
    add('HR/Performance review template.md', "# Performance review\n\n## What went well\n\n## What to improve\n\n## Goals for next half\n\n## Rating (1-5)\n", 200)
    add('HR/Holiday calendar 2026.csv', csv([['Date', 'Holiday']] + [['2026-01-26', 'Republic Day'], ['2026-03-04', 'Holi'], ['2026-08-15', 'Independence Day'], ['2026-10-02', 'Gandhi Jayanti'], ['2026-10-20', 'Dussehra'], ['2026-11-08', 'Diwali'], ['2026-12-25', 'Christmas']]), 280)
    # Marketing
    add('Marketing/Atlas campaign plan.md', "# Atlas launch campaign\n\n- Channels: LinkedIn, email, two webinars\n- Budget: INR 21 lakh\n- Launch post goes live on 28 November\n- Owner: Samir Singh\n", 14)
    add('Marketing/Brand guidelines.pdf', pdf(['Brand guidelines v3', 'Primary colour: deep teal', 'Font: Inter', 'Logo clear space: 1x the mark height']), 160)
    add('Marketing/Webinar leads.csv', csv([['Name', 'Company', 'Email', 'Score']] + [[f"{R.choice(FIRST)} {R.choice(LAST)}", R.choice(['Kestrel Labs', 'Bluefin Bank', 'Orbit Retail', 'Lotus Health', 'Monsoon Media']), f'lead{n}@example.test', R.randint(10, 99)] for n in range(25)]), 7)
    add('Marketing/Social posts October.md', "# Social posts, October\n\n1. Atlas teaser (Oct 20)\n2. Customer story: Bluefin Bank (Oct 23)\n3. Diwali greeting (Nov 6)\n", 10)
    add('Marketing/Press release draft.md', "# Farm Test launches Atlas\n\nPUNE, 28 November 2026: Farm Test today launched Atlas, a self-service portal for enterprise customers...\n", 4)
    add('Marketing/Logo.png', image('Farm Test logo', 'PNG', (512, 512)), 160)
    # Photos
    for k in range(1, 13):
        add(f'Photos/Offsite Goa/IMG_{2400 + k}.jpg', image(f'Goa offsite {k}'), 210)
    for k in range(1, 7):
        add(f'Photos/Team lunch/IMG_{3100 + k}.jpg', image(f'Team lunch {k}'), 45)
    for k in range(1, 4):
        add(f'Photos/Whiteboard/Whiteboard {k}.png', image(f'Whiteboard sketch {k}', 'PNG'), 20 + k)
    add('Photos/Diwali party 2025.jpg', image('Diwali party 2025'), 350)
    # Documents
    add('Documents/Travel/Pune trip itinerary.md', "# Pune trip, 3-5 November\n\n- Flight AI 853, Mumbai to Pune, 3 Nov 07:10\n- Hotel: Orchid Baner, 2 nights\n- Client meeting at Bluefin Bank, 4 Nov 11:00\n", 5)
    add('Documents/Travel/Boarding pass AI853.pdf', pdf(['BOARDING PASS', 'Passenger: RAO/ASHA', 'Flight AI 853 BOM-PNQ', 'Seat 14C', 'Boarding 06:40']), 5)
    add('Documents/Travel/Visa checklist Japan.md', "# Japan visa checklist\n\n- Passport, 6 months valid\n- Photo 45x35 mm\n- Bank statements, 3 months\n- Invitation letter\n", 70)
    add('Documents/Personal/Reading list.md', "# Reading list\n\n- The Making of Prime Ministers\n- Thinking in Systems\n- The Design of Everyday Things\n", 60)
    add('Documents/Personal/Recipes.md', "# Recipes\n\n## Masoor dal\nLentils, onion, tomato, cumin, garlic. 20 minutes in the pressure cooker.\n", 90)
    add('Documents/Personal/Car service log.txt', "2025-11-02 First service, 10,000 km\n2026-05-14 Second service, 20,400 km\nNext service due: 30,000 km\n", 150)
    add('Documents/Personal/Rent agreement 2026.pdf', pdf(['Leave and licence agreement', 'Flat 402, Baner, Pune', 'Rent: INR 30,000 per month', 'Term: 11 months from 1 Jan 2026']), 280)
    add('Documents/Contracts/BrightDesk renewal.pdf', pdf(['BrightDesk service renewal', 'Term: 1 year', 'Fee: INR 4,80,000', 'Renewal date: 1 December 2026']), 20)
    add('Documents/Contracts/Cloudnine hosting MSA.pdf', pdf(['Master services agreement', 'Cloudnine Hosting', 'Uptime SLA 99.9%']), 260)
    add('Documents/Contracts/NDA Kestrel Labs.pdf', pdf(['Mutual NDA', 'Kestrel Labs and Farm Test Pvt Ltd', 'Term: 3 years']), 75)
    # Notes (the Notes app reads this folder)
    notes = {
        'Ideas for team offsite': "Ideas for team offsite\n\n- Coorg instead of Goa?\n- Half day hackathon\n- Cooking class\n",
        'Books to buy': "Books to buy\n\n- Atomic Habits\n- An Elegant Puzzle\n",
        '1-1 with Rohan': "1-1 with Rohan\n\n- Atlas QA plan\n- His leave in December\n- Promotion case\n",
        'Grocery list': "Grocery list\n\n- Rice\n- Toor dal\n- Curd\n- Coriander\n",
        'Wi-Fi at the Pune office': "Wi-Fi at the Pune office\n\nNetwork: FarmGuest\nAsk reception for the code.\n",
        'Questions for the auditor': "Questions for the auditor\n\n- Scope of access review sample\n- Evidence format for backups\n",
        'Gift ideas for Meera': "Gift ideas for Meera\n\n- Pottery class voucher\n- Noise cancelling earbuds\n",
        'Weekend plan': "Weekend plan\n\n- Saturday: car service\n- Sunday: lunch with parents\n",
        'Podcast notes': "Podcast notes\n\nEpisode on platform teams: keep the paved road small.\n",
        'Quarterly review talking points': "Quarterly review talking points\n\n- Atlas on track\n- Cloud spend down 11% so far\n- Two hires joined\n",
        'Vendor shortlist': "Vendor shortlist\n\n- Greenleaf Catering\n- SkyRoute Travels\n",
        'Passwords to rotate': "Passwords to rotate\n\n- Shared Figma admin\n- Old Jenkins service account\n",
        'Workout routine': "Workout routine\n\nMon/Wed/Fri: 30 min run\nTue/Thu: yoga\n",
        'Diwali guest list': "Diwali guest list\n\n- Neha and family\n- Karan\n- Tara\n",
        'Meeting room codes': "Meeting room codes\n\nBoardroom: 4412\nFocus room: 1187\n",
    }
    for t, body in notes.items():
        add(f'Notes/{t}.md', body, R.randint(1, 40))
    # Templates
    add('Templates/Meeting notes template.md', "# Meeting: <title>\n\nDate:\nAttendees:\n\n## Agenda\n\n## Decisions\n\n## Actions\n", 300)
    add('Templates/Status report template.md', "# Status report\n\nProject:\nStatus: green / amber / red\n\n## Done this week\n\n## Next week\n\n## Risks\n", 300)
    add('Templates/Invoice template.xlsx', xlsx([['Item', 'Qty', 'Rate', 'Amount'], ['', '', '', '']], 'Invoice'), 300)
    # Archive 2025
    for m in ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']:
        add(f'Archive/2025/Monthly report {m} 2025.md', f"# Monthly report, {m} 2025\n\n- Revenue: INR {R.randint(80, 140)} lakh\n- New customers: {R.randint(3, 15)}\n- Incidents: {R.randint(0, 4)}\n", 300 + R.randint(0, 60))
    add('Archive/2025/Offsite feedback 2025.csv', csv([['Question', 'Average']] + [['Venue', 4.2], ['Sessions', 3.8], ['Food', 4.6], ['Travel', 3.1]]), 330)
    return f


def other_files(p):
    f = {}
    f[f"Notes from {p['first']}.md"] = (f"# Notes from {p['first']}\n\nThings to share with the team this week.\n", R.randint(1, 30))
    f[f"{p['group']}/Plan 2026 {p['first']}.md"] = (f"# {p['group']} plan by {p['name']}\n\n- Goal 1\n- Goal 2\n", R.randint(5, 90))
    f[f"{p['group']}/Report {p['first']} Q3.xlsx"] = (xlsx([['Metric', 'Value'], ['Tickets', R.randint(10, 300)], ['NPS', R.randint(20, 70)]]), R.randint(5, 60))
    f[f"Photos/Holiday {p['first']}.jpg"] = (image(f"{p['first']} holiday"), R.randint(20, 200))
    return f


def write_tree(uid, files):
    root = os.path.join(DATA, uid, 'files')
    for path, (content, days) in files.items():
        full = os.path.join(root, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, 'wb') as fh:
            fh.write(content if isinstance(content, bytes) else content.encode())
        ts = ago(days).timestamp()
        os.utime(full, (ts, ts))
    # Folders take the newest mtime of what they hold (the scanner reads it).
    for d, subs, fs in sorted(os.walk(root), key=lambda w: -w[0].count('/')):
        kids = [os.path.getmtime(os.path.join(d, x)) for x in subs + fs]
        if kids and d != root: os.utime(d, (max(kids), max(kids)))


def make_files():
    mine = drive_files()
    write_tree(ME['uid'], mine)
    shared_out = {
        'Rohan Kapoor': (f"Shared with Asha/Atlas demo script.md", "# Atlas demo script\n\n1. Log in with SSO\n2. Show invoices\n3. Raise a ticket\n"),
        'Ritu Nair': ('Shared with Asha/Q4 forecast.xlsx', xlsx([['Month', 'Forecast'], ['October', 3400000], ['November', 3650000], ['December', 3900000]])),
        'Priya Berg': ('Shared with Asha/Candidate pipeline.csv', csv([['Candidate', 'Stage']] + [[c, R.choice(['Screen', 'Panel', 'Offer'])] for c in CANDIDATES])),
        'Samir Singh': ('Shared with Asha/Launch banner.png', image('Atlas launch banner', 'PNG', (1200, 400))),
        'Neha Menon': ('Shared with Asha/Goa venue options.md', "# Goa venue options\n\n1. Sea Breeze Resort: INR 9,500 per night\n2. Palm Grove: INR 7,800 per night\n"),
    }
    for p in OTHERS:
        fs = other_files(p)
        for who, (path, content) in shared_out.items():
            if who == p['name']:
                fs[path] = (content, R.randint(1, 20))
        write_tree(p['uid'], fs)
    print(occ('files:scan', '--all', '-q') or 'scanned')
    return mine


def share(owner, path, with_, stype=0, perms=None):
    data = {'path': '/' + path, 'shareType': stype, 'shareWith': with_}
    if perms: data['permissions'] = perms
    r = ocs('POST', '/ocs/v2.php/apps/files_sharing/api/v1/shares', uid=owner, data=data)
    if r.status_code != 200: print('share', owner, path, with_, r.status_code, r.text[:200])


def make_shares():
    me = ME['uid']
    share(me, 'Projects/Atlas launch', 'rohan.kapoor', perms=31)
    share(me, 'Projects/Atlas launch', 'samir.singh', perms=1)
    share(me, 'Finance/Budget Q4 2026.xlsx', 'Finance', stype=1)
    share(me, 'HR/Hiring plan 2026.md', 'priya.berg', perms=19)
    share(me, 'Projects/Customer offsite', 'neha.menon', perms=31)
    share(me, 'Projects/Security audit', 'dev.khan', perms=31)
    share(me, 'Marketing', 'Marketing', stype=1, perms=31)
    share(me, 'Photos/Offsite Goa', 'Leadership', stype=1, perms=1)
    by = {p['name']: p['uid'] for p in PEOPLE}
    for who, path in [('Rohan Kapoor', 'Shared with Asha/Atlas demo script.md'), ('Ritu Nair', 'Shared with Asha/Q4 forecast.xlsx'), ('Priya Berg', 'Shared with Asha/Candidate pipeline.csv'),
                      ('Samir Singh', 'Shared with Asha/Launch banner.png'), ('Neha Menon', 'Shared with Asha/Goa venue options.md')]:
        share(by[who], path, me)
    for p in R.sample(OTHERS, 8):
        share(p['uid'], f"Notes from {p['first']}.md", me)


def make_favorites():
    for path in ['Quarterly OKRs.md', 'Finance/Budget Q4 2026.xlsx', 'Projects/Atlas launch', 'HR/Hiring plan 2026.md', 'Todo.txt', 'Documents/Travel/Pune trip itinerary.md']:
        body = '<?xml version="1.0"?><d:propertyupdate xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:set><d:prop><oc:favorite>1</oc:favorite></d:prop></d:set></d:propertyupdate>'
        r = S.request('PROPPATCH', f"{BASE}/remote.php/dav/files/{ME['uid']}/{requests.utils.quote(path)}", auth=auth(ME['uid']), data=body)
        if r.status_code >= 300: print('fav', path, r.status_code)


# ---------- calendar ----------
def ics_time(dt):
    return dt.astimezone(timezone.utc).strftime('%Y%m%dT%H%M%SZ')


def put_event(uid, cal, summary, start, end, location='', desc='', allday=False, rrule=''):
    eid = str(uuid.UUID(int=R.getrandbits(128)))
    lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//farm.test//seed//EN', 'BEGIN:VEVENT', f'UID:{eid}', f'DTSTAMP:{ics_time(datetime.now(timezone.utc))}', f'SUMMARY:{summary}']
    if allday:
        lines += [f'DTSTART;VALUE=DATE:{start.strftime("%Y%m%d")}', f'DTEND;VALUE=DATE:{end.strftime("%Y%m%d")}']
    else:
        lines += [f'DTSTART:{ics_time(start)}', f'DTEND:{ics_time(end)}']
    if location: lines.append(f'LOCATION:{location}')
    if desc: lines.append('DESCRIPTION:' + desc.replace('\n', '\\n'))
    if rrule: lines.append(f'RRULE:{rrule}')
    lines += ['END:VEVENT', 'END:VCALENDAR']
    r = S.put(f'{BASE}/remote.php/dav/calendars/{uid}/{cal}/{eid}.ics', auth=auth(uid), data='\r\n'.join(lines) + '\r\n', headers={'Content-Type': 'text/calendar'})
    if r.status_code >= 300: print('event', summary, r.status_code, r.text[:200])


def make_calendar():
    me = ME['uid']
    mk = '<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"><d:set><d:prop><d:displayname>{}</d:displayname><a:calendar-color>{}</a:calendar-color></d:prop></d:set></c:mkcalendar>'
    for uri, name, color in [('work', 'Work', '#0082c9'), ('holidays', 'Holidays', '#e9322d')]:
        r = S.request('MKCALENDAR', f'{BASE}/remote.php/dav/calendars/{me}/{uri}/', auth=auth(me), data=mk.format(name, color))
        if r.status_code >= 300: print('calendar', uri, r.status_code)
    used = set()
    def at(day, h, m=0):
        return datetime.combine(day, datetime.min.time(), IST) + timedelta(hours=h, minutes=m)
    # recurring standup
    first_mon = TODAY - timedelta(days=TODAY.weekday() + 56)
    put_event(me, 'work', 'Ops standup', at(first_mon, 9, 30), at(first_mon, 9, 45), 'Google Meet', 'Daily check-in', rrule='FREQ=WEEKLY;BYDAY=MO,WE,FR')
    events = []
    for p in OTHERS[:18]:
        events.append((f"1:1 with {p['name']}", 'work', 30, 'Focus room', f"Weekly 1:1 with {p['first']}"))
    for name in PROJECTS:
        events += [(f'{name} review', 'work', 60, 'Boardroom', f'Status review for {name}'), (f'{name} planning', 'work', 90, 'Boardroom', '')]
    for c in CANDIDATES:
        events.append((f'Interview: {c}', 'work', 60, 'Interview room 2', 'Panel interview'))
    events += [(t, 'work', d, loc, '') for t, d, loc in [
        ('Q4 budget review with Ritu', 60, 'Finance room'), ('Board prep', 120, 'Boardroom'), ('All hands', 60, 'Cafeteria'), ('Vendor call: BrightDesk', 30, 'Zoom'),
        ('Vendor call: Cloudnine Hosting', 30, 'Zoom'), ('Security training', 90, 'Training room'), ('Atlas go/no-go', 60, 'Boardroom'), ('Customer call: Bluefin Bank', 45, 'Zoom'),
        ('Customer call: Orbit Retail', 45, 'Zoom'), ('Leadership sync', 60, 'Boardroom'), ('Hiring committee', 60, 'Boardroom'), ('Design critique', 60, 'Studio'),
        ('Webinar: Atlas for banks', 60, 'Online'), ('Sprint demo', 45, 'Cafeteria'), ('Retro: Data migration', 60, 'Focus room'), ('Quarterly business review', 120, 'Boardroom'),
        ('Offsite planning with Neha', 60, 'Cafe Mocha'), ('Audit kickoff', 60, 'Boardroom'), ('Audit closing meeting', 60, 'Boardroom'), ('Expense policy review', 30, 'Finance room')]]
    events += [(t, 'personal', d, loc, '') for t, d, loc in [
        ('Dentist appointment', 45, 'Smile Dental, Baner'), ('Car service', 120, 'Tata Motors, Aundh'), ('Lunch with Meera', 60, 'Malaka Spice'), ('Yoga class', 60, 'Studio Prana'),
        ("Parents' anniversary dinner", 120, 'Home'), ('Haircut', 45, 'Looks Salon'), ('Parent-teacher meeting', 60, 'DPS Pune'), ('Gym trial session', 60, 'Cult Baner'),
        ('Coffee with Karan', 45, 'Third Wave Coffee'), ('Bank visit: home loan', 60, 'HDFC Baner'), ('Movie night', 150, 'PVR Phoenix'), ('Badminton with Arjun', 60, 'Sports club'),
        ('Pick up passport', 30, 'Passport Seva Kendra'), ('Diwali shopping', 120, 'Phoenix Mall'), ('Doctor follow-up', 30, 'Ruby Hall Clinic')]]
    R.shuffle(events)
    for k, (title, cal, mins, loc, desc) in enumerate(events):
        off = R.randint(-58, 58)
        day = TODAY + timedelta(days=off)
        if day.weekday() >= 5 and cal == 'work': day += timedelta(days=2)
        h = R.choice([10, 11, 12, 14, 15, 16, 17]) if cal == 'work' else R.choice([8, 13, 18, 19, 20])
        m = R.choice([0, 0, 30])
        put_event(me, cal, title, at(day, h, m), at(day, h, m) + timedelta(minutes=mins), loc, desc)
    # trips (multi-day, all-day)
    put_event(me, 'personal', 'Pune client trip', date(2026, 11, 3), date(2026, 11, 6), 'Pune', '', allday=True)
    put_event(me, 'work', 'Customer offsite in Goa', date(2026, 12, 4), date(2026, 12, 6), 'Goa', '', allday=True)
    put_event(me, 'personal', 'Leave: Kerala holiday', date(2026, 9, 21), date(2026, 9, 26), 'Kerala', '', allday=True)
    for d, t in [('2026-10-02', 'Gandhi Jayanti'), ('2026-10-20', 'Dussehra'), ('2026-11-08', 'Diwali'), ('2026-11-24', 'Guru Nanak Jayanti'), ('2026-12-25', 'Christmas'), ('2026-08-15', 'Independence Day'), ('2026-09-05', 'Janmashtami')]:
        dd = date.fromisoformat(d)
        put_event(me, 'holidays', t, dd, dd + timedelta(days=1), allday=True)
    # a few for colleagues
    for p in OTHERS[:10]:
        for _ in range(3):
            day = TODAY + timedelta(days=R.randint(-20, 30))
            put_event(p['uid'], 'personal', R.choice(['Team sync', 'Client call', 'Focus time', 'Lunch']), at(day, 11), at(day, 12))
    return len(events) + 1 + 3 + 7


# ---------- contacts ----------
COMPANIES = ['Kestrel Labs', 'Bluefin Bank', 'Orbit Retail', 'Lotus Health', 'Monsoon Media', 'Northwind Traders', 'AcmePay', 'BrightDesk', 'SkyRoute Travels', 'Greenleaf Catering']
TITLES = ['CTO', 'Head of Procurement', 'Account Manager', 'Product Manager', 'Engineering Manager', 'Sales Director', 'Founder', 'Finance Controller', 'Designer', 'Consultant']
CFIRST = ['Aarti', 'Bhavesh', 'Chitra', 'Deepak', 'Esha', 'Gaurav', 'Harini', 'Jatin', 'Kriti', 'Lokesh', 'Manish', 'Naina', 'Ojas', 'Pallavi', 'Qadir', 'Rhea', 'Siddharth',
          'Trisha', 'Uday', 'Vani', 'Wasim', 'Yamini', 'Zubin', 'Anil', 'Bindu', 'Sofia', 'Liam', 'Yuki', 'Kwame', 'Ingrid', 'Pierre', 'Carmen']
CLAST = ['Agarwal', 'Bhatt', 'Chopra', 'Dutta', 'Desai', 'Hegde', 'Jain', 'Krishnan', 'Lal', 'Mishra', 'Naidu', 'Oberoi', 'Prasad', 'Saxena', 'Thakur', 'Varghese', 'Wadia',
         'Yadav', 'Zaveri', 'Martins', 'Kim', 'Andersen', 'Dubois', 'Mensah', 'Lopez']


def make_contacts():
    me = ME['uid']
    url = f'{BASE}/remote.php/dav/addressbooks/users/{me}/contacts/'
    if S.request('PROPFIND', url, auth=auth(me), headers={'Depth': '0'}).status_code >= 300:
        S.request('MKCOL', url, auth=auth(me), data='<?xml version="1.0"?><d:mkcol xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav"><d:set><d:prop><d:resourcetype><d:collection/><c:addressbook/></d:resourcetype><d:displayname>Contacts</d:displayname></d:prop></d:set></d:mkcol>')
    names = set(); n = 0
    while len(names) < 56:
        fn, ln = R.choice(CFIRST), R.choice(CLAST)
        if (fn, ln) in names: continue
        names.add((fn, ln))
    for fn, ln in sorted(names):
        cid = str(uuid.UUID(int=R.getrandbits(128)))
        org = R.choice(COMPANIES)
        dom = org.lower().replace(' ', '') + '.test'
        lines = ['BEGIN:VCARD', 'VERSION:4.0', 'PRODID:-//farm.test//seed//EN', f'UID:{cid}', f'FN:{fn} {ln}', f'N:{ln};{fn};;;', f'ORG:{org}', f'TITLE:{R.choice(TITLES)}',
                 f'EMAIL;TYPE=WORK:{fn.lower()}.{ln.lower()}@{dom}', f'TEL;TYPE=CELL:+91 9{R.randint(100000000, 999999999)}']
        if R.random() < 0.4: lines.append(f'TEL;TYPE=WORK:+91 20 {R.randint(2000, 7999)} {R.randint(1000, 9999)}')
        if R.random() < 0.3: lines.append(f'ADR;TYPE=WORK:;;{R.randint(1, 400)} {R.choice(["MG Road", "Baner Road", "FC Road", "Linking Road", "Residency Road"])};{R.choice(["Pune", "Mumbai", "Bengaluru"])};;{R.randint(400001, 560099)};India')
        if R.random() < 0.3: lines.append(f'BDAY:{R.randint(1970, 1998)}-{R.randint(1, 12):02d}-{R.randint(1, 28):02d}')
        if R.random() < 0.2: lines.append(f'NOTE:Met at {R.choice(["Nasscom summit", "Bluefin offsite", "a webinar", "SaaSBoomi"])}')
        lines.append('END:VCARD')
        r = S.put(url + f'{cid}.vcf', auth=auth(me), data='\r\n'.join(lines) + '\r\n', headers={'Content-Type': 'text/vcard'})
        if r.status_code >= 300: print('contact', fn, r.status_code, r.text[:200])
        n += 1
    return n


# ---------- deck ----------
def deck(method, path, uid=None, **kw):
    r = S.request(method, f'{BASE}/index.php/apps/deck/api/v1.0{path}', auth=auth(uid or ME['uid']), headers={'OCS-APIRequest': 'true', 'Accept': 'application/json'}, **kw)
    if r.status_code >= 300: print('deck', method, path, r.status_code, r.text[:200])
    return r.json() if r.text.startswith(('{', '[')) else {}


BOARDS = [
    ('Atlas Launch', '0082c9', ['Backlog', 'In progress', 'Review', 'Done'], ['Frontend', 'Backend', 'Bug', 'Docs'],
     ['Set up SSO for Bluefin Bank', 'Invoice list pagination', 'Fix date format on statements', 'Support runbook', 'Status page', 'Announcement email copy', 'Load test the API',
      'Dark mode for portal', 'Password reset flow', 'Audit log export', 'Billing webhook retries', 'Onboarding tour', 'Accessibility review', 'Error page design',
      'Rate limit the login API', 'CSV export of tickets', 'Customer admin roles', 'Release notes v1.0', 'Fix slow dashboard query', 'Translate UI to Hindi', 'Pricing page FAQ', 'Smoke tests in CI']),
    ('Marketing Q4', 'e9a23b', ['Ideas', 'Planned', 'Doing', 'Published'], ['LinkedIn', 'Email', 'Event', 'Blog'],
     ['Atlas teaser post', 'Customer story: Bluefin Bank', 'Diwali greeting', 'Webinar: Atlas for banks', 'Newsletter November', 'Case study: Orbit Retail', 'Launch press release',
      'Booth at SaaSBoomi', 'Founder video', 'Blog: why we built Atlas', 'Partner email to AcmePay', 'Year in review post', 'Landing page A/B test', 'Retarget webinar leads',
      'Podcast guest slot', 'Product Hunt launch', 'Holiday gift boxes', 'Update brand guidelines', 'Comparison page', 'Analyst briefing deck']),
    ('Hiring 2026', '49b675', ['Sourced', 'Screening', 'Interview', 'Offer', 'Joined'], ['Engineering', 'Design', 'Support', 'Urgent'],
     ['Aarav Malhotra - Backend', 'Sneha Pillai - Designer', 'Jonas Weber - Frontend', 'Ritika Sen - Backend', 'Mohit Bansal - Support lead', 'Chloe Martin - Designer',
      'Irfan Qureshi - Backend', 'Kiran Rao - Frontend', 'Lata Iyer - QA', 'Peter Novak - SRE', 'Swati Gupta - Backend', 'Ahmed Khan - Frontend', 'Neel Shah - Data engineer',
      'Mira Das - Support', 'Tomás Silva - SRE', 'Anjali Menon - Designer', 'Rajat Verma - Backend', 'Fatima Ali - QA', 'Gopal Nair - Frontend', 'Emma Berg - Product designer',
      'Vivek Joshi - Backend', 'Sara Okafor - Support']),
]


def make_deck():
    me = ME['uid']
    members = [p['uid'] for p in OTHERS[:9]]
    total = 0
    for title, color, stacks, labels, cards in BOARDS:
        b = deck('POST', '/boards', json={'title': title, 'color': color})
        bid = b['id']
        for u in members:
            deck('POST', f'/boards/{bid}/acl', json={'type': 0, 'participant': u, 'permissionEdit': True, 'permissionShare': False, 'permissionManage': False})
        board = deck('GET', f'/boards/{bid}')
        for l in board.get('labels', []):
            deck('DELETE', f"/boards/{bid}/labels/{l['id']}")
        lids = [deck('POST', f'/boards/{bid}/labels', json={'title': t, 'color': c})['id'] for t, c in zip(labels, ['31CC7C', '317CCC', 'FF7A66', 'F1DB50'])]
        sids = [deck('POST', f'/boards/{bid}/stacks', json={'title': s, 'order': i})['id'] for i, s in enumerate(stacks)]
        for k, ct in enumerate(cards):
            si = k % len(sids)
            due = None
            if R.random() < 0.6:
                due = (datetime.combine(TODAY + timedelta(days=R.randint(-15, 45)), datetime.min.time(), IST) + timedelta(hours=18)).isoformat()
            desc = R.choice(['', f'Owner to update by Friday.', 'See the brief in Files.', 'Blocked on vendor reply.', 'Needs design review first.'])
            c = deck('POST', f'/boards/{bid}/stacks/{sids[si]}/cards', json={'title': ct, 'type': 'plain', 'order': k, 'description': desc, **({'duedate': due} if due else {})})
            cid = c['id']
            for lid in R.sample(lids, R.choice([0, 1, 1, 2])):
                deck('PUT', f'/boards/{bid}/stacks/{sids[si]}/cards/{cid}/assignLabel', json={'labelId': lid})
            for u in R.sample([me] + members, R.choice([0, 1, 1, 2])):
                deck('PUT', f'/boards/{bid}/stacks/{sids[si]}/cards/{cid}/assignUser', json={'userId': u})
            if R.random() < 0.3:
                ocs('POST', f'/ocs/v2.php/apps/deck/api/v1.0/cards/{cid}/comments', uid=me, json={'message': R.choice(['Looks good to me.', 'Can we move this to next week?', 'Waiting on legal.', 'Done from my side.'])})
            total += 1
    return total


if __name__ == '__main__':
    import sys
    if len(sys.argv) > 1:  # re-run single stages: python3 nextcloud_seed.py make_contacts
        for fn in sys.argv[1:]: print(fn, globals()[fn]())
        sys.exit(0)
    make_users()
    files = make_files()
    make_shares()
    make_favorites()
    ev = make_calendar()
    nc = make_contacts()
    cards = make_deck()
    print(json.dumps({'users': len(PEOPLE), 'asha_files': len(files), 'events': ev, 'contacts': nc, 'cards': cards}))
