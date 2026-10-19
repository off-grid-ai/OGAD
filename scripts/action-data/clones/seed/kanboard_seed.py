#!/usr/bin/env python3
"""Synthetic Trello-like boards for Kanboard on board.farm.test (held-out TEST app; no real people).

  python3 kanboard_seed.py <api_token>     # run by farm/kanboard/seed.sh on a fresh DB

20 users (persona meera.iyer, manager in every project), 6 projects with swimlanes and categories,
~330 tasks across columns with owners, due dates, tags, comments and subtasks; some closed.
Every account uses the farm test password from clones/farm/accounts.json.
"""
import json, os, random, sys
from datetime import date, timedelta
import requests

R = random.Random(20261016)
HERE = os.path.dirname(os.path.abspath(__file__))
PASSWORD = json.load(open(os.path.join(HERE, '..', 'farm', 'accounts.json')))['password']
URL = 'http://board.farm.test/jsonrpc.php'
ME = 'meera.iyer'
TODAY = date(2026, 10, 16)

NAMES = [('Meera', 'Iyer'), ('Rohan', 'Mehta'), ('Priya', 'Shah'), ('Kabir', 'Khan'), ('Asha', 'Rao'), ('Arjun', 'Nair'), ('Neha', 'Sharma'),
         ('Vikram', 'Das'), ('Isha', 'Kapoor'), ('Dev', 'Joshi'), ('Ananya', 'Bose'), ('Karan', 'Pillai'), ('Tara', 'Singh'), ('Nikhil', 'Menon'),
         ('Sana', 'Reddy'), ('Elena', 'Rossi'), ('Lucas', 'Silva'), ('Hana', 'Tanaka'), ('Grace', 'Okafor'), ('Noah', 'Berg')]
PROJECTS = [
    ('Website Relaunch', 'New marketing site and blog for the Diwali launch', ['Design', 'Content', 'Development', 'SEO'], ['Main', 'Blocked']),
    ('Mobile App v3', 'Android and iOS release 3.0', ['Bug', 'Feature', 'UX', 'QA'], ['Android', 'iOS']),
    ('Store Openings Q4', 'Opening five new stores before December', ['Fit-out', 'Hiring', 'Permits', 'Stock'], ['Pune', 'Kochi', 'Indore']),
    ('Hiring Pipeline', 'Engineering and design hiring', ['Backend', 'Frontend', 'Design', 'Data'], ['Main']),
    ('Customer Support', 'Escalations and support tooling', ['Billing', 'Delivery', 'Account', 'Tooling'], ['Main', 'Urgent']),
    ('Office Move', 'Moving the Bengaluru office to the new floor', ['Facilities', 'IT', 'Admin'], ['Main']),
]
TASKS = {
    'Website Relaunch': ['Write the About page copy', 'Design the hero banner', 'Set up the blog CMS', 'Fix mobile menu overlap', 'Add Hindi translation',
                         'Compress homepage images', 'Write 5 launch blog posts', 'Set up redirects from old URLs', 'Add cookie consent banner', 'Create the pricing page',
                         'Review page titles and meta tags', 'Add newsletter signup form', 'Test forms on Safari', 'Pick stock photos for team page', 'Launch checklist review'],
    'Mobile App v3': ['Crash on login with Google', 'Dark mode for settings', 'Offline cart sync', 'Push notification opt-in screen', 'Update app store screenshots',
                      'Fix date picker on Android 12', 'Biometric unlock', 'Order history pagination', 'Reduce app size below 40 MB', 'Accessibility labels on checkout',
                      'Release notes for 3.0', 'Beta testers feedback round', 'Payment retry flow', 'Fix keyboard covering input', 'Analytics events for search'],
    'Store Openings Q4': ['Sign the lease', 'Order shelving', 'Hire store manager', 'Apply for trade license', 'Install POS terminals', 'Fire safety inspection',
                          'First stock delivery', 'Train staff on POS', 'Signage approval', 'Opening day event plan', 'Set up CCTV', 'Internet connection',
                          'Local ads in newspapers', 'Cold storage setup', 'Inventory count before opening'],
    'Hiring Pipeline': ['Screen backend candidates', 'Schedule design interviews', 'Update job description for SRE', 'Send offer to frontend candidate',
                        'Campus drive at IIT Bombay', 'Take-home task review', 'Reference checks', 'Post roles on job boards', 'Interview panel training',
                        'Onboarding plan for new joiners', 'Salary benchmarking', 'Referral bonus payout', 'Collect interview feedback', 'Close data analyst role'],
    'Customer Support': ['Refund for duplicate charge', 'Late delivery complaints in Kochi', 'Account locked after password reset', 'Invoice missing GST number',
                         'Update refund macro', 'Weekly CSAT report', 'Escalate damaged goods case', 'Chatbot handoff bug', 'Train new support agents',
                         'Bulk order inquiry from Greenleaf', 'Wrong address on shipping label', 'SLA breach review', 'Help center article on returns', 'Phone line outage follow-up'],
    'Office Move': ['Book movers', 'Plan seating chart', 'Set up Wi-Fi on new floor', 'Order new chairs', 'Move server rack', 'Update address with vendors',
                    'Access cards for everyone', 'Pantry setup', 'Meeting room names vote', 'Dispose of old furniture', 'Fire drill on new floor', 'Parking allocation'],
}
COMMENTS = ['Started on this today.', 'Blocked on approval from finance.', 'Done, please review.', 'Can we push this to next week?', 'Vendor confirmed the date.',
            'I need more details on this.', 'Added the files to the shared drive.', 'This is higher priority now.', 'Waiting for the client reply.', 'Looks good to me.',
            'Moved the deadline after the call.', 'Please assign someone from QA.']
SUBTASKS = ['Draft', 'Review', 'Get approval', 'Update the tracker', 'Test', 'Share with the team', 'Collect quotes', 'Book a slot', 'Send reminder']
TAGS = ['urgent', 'quick win', 'needs review', 'customer', 'blocked', 'q4']
COLORS = ['yellow', 'blue', 'green', 'purple', 'red', 'orange', 'grey', 'brown', 'deep_orange', 'dark_grey', 'pink', 'teal', 'cyan', 'lime', 'light_green', 'amber']

s = requests.Session()
s.auth = ('jsonrpc', sys.argv[1])
_id = 0


def rpc(method, **params):
    global _id
    _id += 1
    r = s.post(URL, json={'jsonrpc': '2.0', 'method': method, 'id': _id, 'params': params}, timeout=60).json()
    if 'error' in r: raise RuntimeError(f'{method}: {r["error"]}')
    return r['result']


def main():
    users = {}
    for i, (first, last) in enumerate(NAMES):
        u = f'{first.lower()}.{last.lower()}'
        users[u] = rpc('createUser', username=u, password=PASSWORD, name=f'{first} {last}', email=f'{u}@farm.test', role='app-manager' if u == ME else 'app-user')
    admin = rpc('createUser', username='farmadmin', password=PASSWORD, name='Farm Admin', email='farmadmin@farm.test', role='app-admin')
    old = rpc('getUserByName', username='admin')
    if old: rpc('removeUser', user_id=int(old['id']))
    unames = list(users)
    n_tasks = n_comments = n_sub = 0
    for pname, desc, cats, lanes in PROJECTS:
        pid = rpc('createProject', name=pname, description=desc, owner_id=users[ME])
        rpc('addProjectUser', project_id=pid, user_id=users[ME], role='project-manager')
        team = [ME] + R.sample(unames[1:], R.randint(6, 10))
        for u in team[1:]: rpc('addProjectUser', project_id=pid, user_id=users[u], role='project-member')
        cat_ids = [rpc('createCategory', project_id=pid, name=c) for c in cats]
        lane_ids = []
        sw = rpc('getActiveSwimlanes', project_id=pid)
        rpc('updateSwimlane', project_id=pid, swimlane_id=int(sw[0]['id']), name=lanes[0])
        lane_ids.append(int(sw[0]['id']))
        for ln in lanes[1:]: lane_ids.append(rpc('addSwimlane', project_id=pid, name=ln))
        cols = [int(c['id']) for c in rpc('getColumns', project_id=pid)]
        titles = TASKS[pname]
        # Each title once or twice (with a short suffix) so tasks are many but names stay readable.
        all_titles = titles + [f'{t} ({R.choice(["phase 2", "follow-up", "round 2", "v2"])})' for t in titles]
        for k, title in enumerate(R.sample(all_titles, len(all_titles))):
            for rep in range(1 + (k % 3 == 0) + (k % 2 == 0)):
                t = title if rep == 0 else f'{title} - {["Pune", "Kochi", "Delhi", "team B", "vendor"][(k + rep) % 5]}'
                due = (TODAY + timedelta(days=R.randint(-20, 45))).isoformat() if R.random() < 0.7 else None
                params = dict(title=t, project_id=pid, column_id=R.choice(cols), swimlane_id=R.choice(lane_ids), category_id=R.choice(cat_ids),
                              owner_id=users[R.choice(team)] if R.random() < 0.8 else 0, creator_id=users[R.choice(team)], color_id=R.choice(COLORS),
                              priority=R.randint(0, 3), score=R.choice([0, 1, 2, 3, 5, 8]), description=f'{R.choice(COMMENTS)}\n\nContext: {desc.lower()}.',
                              tags=R.sample(TAGS, R.choice([0, 0, 1, 1, 2])))
                if due: params['date_due'] = due
                tid = rpc('createTask', **params)
                n_tasks += 1
                for _ in range(R.choice([0, 0, 1, 1, 2, 3])):
                    rpc('createComment', task_id=tid, user_id=users[R.choice(team)], content=R.choice(COMMENTS)); n_comments += 1
                for st in R.sample(SUBTASKS, R.choice([0, 0, 0, 2, 3])):
                    rpc('createSubtask', task_id=tid, title=st, user_id=users[R.choice(team)], status=R.choice([0, 0, 1, 2])); n_sub += 1
                if R.random() < 0.12: rpc('closeTask', task_id=tid)
    print(json.dumps({'users': len(users) + 1, 'projects': len(PROJECTS), 'tasks': n_tasks, 'comments': n_comments, 'subtasks': n_sub}))


if __name__ == '__main__':
    main()
