"""Seed EtherCalc (tables kept to <= 13 data rows: only 13-17 grid rows are visible at the capture viewports) (sheets.farm.test): 45 sheets (budgets, regional sales, inventory, expenses, grades) with formulas.
Writes each room via the REST API (PUT csv + POST formula commands), then saves the SocialCalc snapshot of every
room to /workspace/clone-farm/snap/ethercalc/<room>.sc for reset.sh.   python3 ethercalc_seed.py"""
import csv, io, os, random, sys, requests
sys.path.insert(0, os.path.dirname(__file__))
from data_common import people, PRODUCTS, REGIONS, FIRST, LAST

API = 'http://127.0.0.1:7130'
SNAP = '/workspace/clone-farm/snap/ethercalc'
rng = random.Random(4471)
os.makedirs(SNAP, exist_ok=True)
for f in os.listdir(SNAP): os.remove(os.path.join(SNAP, f))
COLS = 'ABCDEFGHIJ'
sheets = []


def add(room, rows, formulas):
    sheets.append((room, rows, formulas))


# Budgets: Category | Planned | Actual | Variance (=C-B), total row on half of them.
BUDGET_CATS = ['Salaries', 'Rent', 'Travel', 'Software', 'Hardware', 'Training', 'Marketing', 'Events', 'Consultants', 'Utilities',
               'Insurance', 'Office Supplies', 'Meals', 'Recruiting', 'Legal', 'Cloud Hosting']
for dept in ['marketing', 'engineering', 'sales', 'operations', 'hr', 'finance', 'support', 'design', 'legal']:
    cats = rng.sample(BUDGET_CATS, rng.randint(6, 10))
    rows = [['Category', 'Planned', 'Actual', 'Variance']]
    f = []
    for i, c in enumerate(cats, start=2):
        p = rng.randrange(20, 900) * 1000; a = int(p * rng.uniform(0.7, 1.25) / 100) * 100
        rows.append([c, p, a, ''])
        f.append(f'set D{i} formula C{i}-B{i}')
    if rng.random() < 0.5:
        n = len(rows) + 1
        rows.append(['Total', '', '', ''])
        f += [f'set B{n} formula SUM(B2:B{n-1})', f'set C{n} formula SUM(C2:C{n-1})', f'set D{n} formula C{n}-B{n}']
    add(f'budget-{dept}-2026', rows, f)

# Regional sales: Rep | Region | Units | Revenue (no total row: SUM tasks write it).
for region in ['north', 'south', 'east', 'west', 'central']:
    for q in rng.sample(['q1', 'q2', 'q3', 'q4'], 2):
        reps = people(rng, rng.randint(6, 12))
        rows = [['Rep', 'Region', 'Units', 'Revenue']]
        for r in reps:
            u = rng.randint(12, 480)
            rows.append([r, region.title(), u, u * rng.choice([850, 1200, 1499, 2100, 3250])])
        add(f'sales-{region}-{q}-2026', rows, [])

# Inventory: SKU | Item | Qty | Unit Price | Value (=C*D).
for wh in ['mumbai', 'pune', 'delhi', 'bengaluru', 'chennai', 'hyderabad', 'kolkata', 'ahmedabad']:
    items = rng.sample(PRODUCTS, rng.randint(7, 12))
    rows = [['SKU', 'Item', 'Qty', 'Unit Price', 'Value']]
    f = []
    for i, it in enumerate(items, start=2):
        rows.append([f'{wh[:3].upper()}-{rng.randint(1000, 9999)}', it, rng.randint(0, 250), rng.choice([49, 99, 149, 199, 249, 499, 899, 1299, 2499, 4999, 12999]), ''])
        f.append(f'set E{i} formula C{i}*D{i}')
    add(f'inventory-{wh}', rows, f)

# Expenses: Date | Description | Category | Amount.
DESC = [('Taxi to airport', 'Travel'), ('Team lunch', 'Meals'), ('Hotel, 2 nights', 'Travel'), ('Printer ink', 'Office'), ('Conference ticket', 'Training'),
        ('Client dinner', 'Meals'), ('Train tickets', 'Travel'), ('Software licence', 'Software'), ('Courier', 'Office'), ('Coworking day pass', 'Office'),
        ('Flight BOM-BLR', 'Travel'), ('Online course', 'Training'), ('Mobile recharge', 'Utilities'), ('Internet bill', 'Utilities'), ('Snacks for workshop', 'Meals')]
for month, mnum in [('july', 7), ('august', 8), ('september', 9)]:
    for team in rng.sample(['design', 'growth', 'platform', 'mobile', 'data', 'sales'], 3):
        rows = [['Date', 'Description', 'Category', 'Amount']]
        days = sorted(rng.sample(range(1, 29), rng.randint(6, 12)))
        for d in days:
            desc, cat = rng.choice(DESC)
            rows.append([f'2026-{mnum:02d}-{d:02d}', desc, cat, rng.randrange(150, 18000, 10)])
        add(f'expenses-{month}-{team}', rows, [])

# Grades: Student | Math | Science | English | Average (=AVERAGE).
for cls in ['7a', '7b', '8a', '8b', '9a', '9b', '10a', '10b', '10c']:
    studs = people(rng, rng.randint(8, 12))
    rows = [['Student', 'Math', 'Science', 'English', 'Average']]
    f = []
    for i, s in enumerate(studs, start=2):
        rows.append([s, rng.randint(38, 100), rng.randint(38, 100), rng.randint(38, 100), ''])
        f.append(f'set E{i} formula ROUND(AVERAGE(B{i}:D{i}),1)')
    add(f'grades-class-{cls}', rows, f)

for room, rows, formulas in sheets:
    buf = io.StringIO(); csv.writer(buf, lineterminator='\n').writerows(rows)
    r = requests.put(f'{API}/_/{room}', data=buf.getvalue().encode(), headers={'Content-Type': 'text/csv'}); r.raise_for_status()
    if formulas:
        r = requests.post(f'{API}/_/{room}', json={'command': formulas}); r.raise_for_status()
for room, _, _ in sheets:
    sc = requests.get(f'{API}/_/{room}').text
    open(f'{SNAP}/{room}.sc', 'w').write(sc)
print('sheets', len(sheets), 'rows', sum(len(r) - 1 for _, r, _ in sheets))
