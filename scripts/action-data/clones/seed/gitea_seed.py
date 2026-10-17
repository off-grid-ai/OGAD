#!/usr/bin/env python3
"""Synthetic GitHub-like forge for Gitea on git.farm.test (no real people or code).

  python3 gitea_seed.py      # Gitea up on 127.0.0.1:7121 with an empty DB; run by farm/gitea/seed.sh

25 users (persona meera.iyer), 3 orgs, 20 repos with READMEs and files, default label set,
milestones, ~320 issues with labels/milestones/assignees/comments and 40 pull requests.
Every account uses the farm test password from clones/farm/accounts.json.
"""
import base64, json, os, random, subprocess
import requests

R = random.Random(20261016)
HERE = os.path.dirname(os.path.abspath(__file__))
PASSWORD = json.load(open(os.path.join(HERE, '..', 'farm', 'accounts.json')))['password']
API = 'http://127.0.0.1:7121/api/v1'
ME = 'meera.iyer'

NAMES = [('Meera', 'Iyer'), ('Rohan', 'Mehta'), ('Priya', 'Shah'), ('Kabir', 'Khan'), ('Asha', 'Rao'), ('Arjun', 'Nair'), ('Neha', 'Sharma'),
         ('Vikram', 'Das'), ('Isha', 'Kapoor'), ('Dev', 'Joshi'), ('Ananya', 'Bose'), ('Karan', 'Pillai'), ('Tara', 'Singh'), ('Nikhil', 'Menon'),
         ('Sana', 'Reddy'), ('Rahul', 'Gupta'), ('Leela', 'Fernandes'), ('Aditya', 'Kulkarni'), ('Elena', 'Rossi'), ('Lucas', 'Silva'),
         ('Hana', 'Tanaka'), ('Mateo', 'Novak'), ('Grace', 'Okafor'), ('Noah', 'Berg'), ('Tenzin', 'Dorje')]
USERS = [f'{f.lower()}.{l.lower()}' for f, l in NAMES]
ORGS = [('orbit-labs', 'Orbit Labs', 'Product engineering for the Orbit apps'),
        ('monsoon-retail', 'Monsoon Retail', 'Store, supply chain and commerce systems'),
        ('open-tools', 'Open Tools', 'Small open-source utilities we maintain')]
# (owner, name, description, language)
REPOS = [
    ('orbit-labs', 'atlas-api', 'REST API for the Atlas mobile app', 'Go'), ('orbit-labs', 'atlas-web', 'Web dashboard for Atlas customers', 'TypeScript'),
    ('orbit-labs', 'nimbus-sync', 'Offline sync engine used by Nimbus', 'Rust'), ('orbit-labs', 'kestrel-android', 'Kestrel Android app', 'Kotlin'),
    ('orbit-labs', 'kestrel-ios', 'Kestrel iOS app', 'Swift'), ('orbit-labs', 'design-system', 'Shared UI components and tokens', 'TypeScript'),
    ('orbit-labs', 'infra', 'Terraform and deployment scripts', 'HCL'), ('monsoon-retail', 'storefront', 'Customer storefront and checkout', 'TypeScript'),
    ('monsoon-retail', 'inventory-service', 'Stock levels across warehouses', 'Python'), ('monsoon-retail', 'pos-terminal', 'Point of sale app for stores', 'Kotlin'),
    ('monsoon-retail', 'pricing-engine', 'Discounts, offers and price rules', 'Python'), ('monsoon-retail', 'supplier-portal', 'Portal for vendors to upload invoices', 'PHP'),
    ('monsoon-retail', 'data-pipeline', 'Nightly sales and stock ETL jobs', 'Python'), ('open-tools', 'csv-kit', 'Fast CSV cleaning from the command line', 'Rust'),
    ('open-tools', 'tiny-cron', 'A minimal cron runner for containers', 'Go'), ('open-tools', 'markdown-lint', 'Opinionated Markdown linter', 'JavaScript'),
    ('open-tools', 'rupee-format', 'Format numbers in the Indian system (lakh, crore)', 'JavaScript'), ('open-tools', 'pdf-split', 'Split and merge PDF files', 'Python'),
    ('meera.iyer', 'dotfiles', 'My shell, git and editor setup', 'Shell'), ('meera.iyer', 'notes-app', 'A tiny Markdown notes app for the terminal', 'Python'),
]
EXT = {'Go': ('main.go', 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("{name} starting")\n}\n'),
       'TypeScript': ('src/index.ts', 'export function start(): void {\n  console.log("{name} starting")\n}\n'),
       'Rust': ('src/main.rs', 'fn main() {\n    println!("{name} starting");\n}\n'),
       'Kotlin': ('app/src/main/MainActivity.kt', 'class MainActivity {\n    fun onCreate() = println("{name} starting")\n}\n'),
       'Swift': ('Sources/App/main.swift', 'print("{name} starting")\n'),
       'HCL': ('main.tf', 'terraform {\n  required_version = ">= 1.6"\n}\n'),
       'Python': ('src/main.py', 'def main():\n    print("{name} starting")\n\n\nif __name__ == "__main__":\n    main()\n'),
       'PHP': ('public/index.php', '<?php\necho "{name} starting";\n'),
       'JavaScript': ('index.js', 'module.exports = function start() {\n  console.log("{name} starting")\n}\n'),
       'Shell': ('install.sh', '#!/bin/sh\nset -e\nln -sf "$PWD/.zshrc" ~/.zshrc\n')}

AREAS = ['login', 'search', 'checkout', 'settings page', 'dashboard', 'export', 'notifications', 'sync', 'onboarding', 'profile page', 'API client',
         'invoice upload', 'dark mode', 'date picker', 'payments', 'cache', 'CSV import', 'build', 'docs', 'release script']
BUGS = ['{area} fails when the name has an apostrophe', '{area} is slow with more than {n}00 items', 'Crash on {area} after the {v} update',
        '{area} shows the wrong time zone', 'Typo in the {area} error message', '{area} button does nothing on Safari', 'Memory leak in {area}',
        '{area} returns 500 for empty input', 'Duplicate entries in {area}', '{area} ignores the language setting']
FEATURES = ['Add CSV export to {area}', 'Support dark mode in {area}', 'Allow keyboard shortcuts in {area}', 'Show a progress bar for {area}',
            'Add retry with backoff to {area}', 'Make {area} work offline', 'Add Hindi translations for {area}', 'Paginate {area} results',
            'Add an audit log for {area}', 'Document the {area} configuration']
BODIES = ['Steps to reproduce:\n1. Open the {area}\n2. Enter some data\n3. Click Save\n\nExpected: it saves.\nActual: {problem}\n\nSeen on version {v}.',
          'We need this for the {month} release. Customers asked for it {n} times last month.\n\nAcceptance criteria:\n- works on mobile\n- has tests',
          'Reported by the support team. It affects about {n} percent of users.\n\nLogs are attached in the support ticket.',
          'Proposal: {problem}\n\nI can pick this up after the {area} work is done.']
PROBLEMS = ['the page freezes', 'nothing happens', 'we get a 500 error', 'the old value comes back', 'the spinner never stops', 'it times out after 30 s']
COMMENTS = ['I can reproduce this on {v}.', 'Looking into it.', 'Fixed in the latest build, please check.', 'Is this still an issue?', '+1, we see this too.',
            'Could you add the browser version?', 'This is a duplicate of an older issue, closing soon.', 'I have a draft PR for this.', 'Moving to the next milestone.',
            'Thanks for the report!', 'Low priority for now, let us revisit after the release.', 'Confirmed with the {area} team.']
PRS = ['Fix {area} timeout', 'Refactor {area} module', 'Add tests for {area}', 'Bump dependencies', 'Improve {area} error messages', 'Speed up {area}',
       'Add {area} docs', 'Clean up unused code in {area}', 'Handle empty input in {area}', 'Add metrics to {area}']


def f(t):
    return t.format(area=R.choice(AREAS), n=R.randint(2, 9), v=f'{R.randint(1, 3)}.{R.randint(0, 12)}.{R.randint(0, 5)}', month=R.choice(['Oct', 'Nov', 'Dec']),
                    problem=R.choice(PROBLEMS))


s = requests.Session()
s.auth = ('farmadmin', PASSWORD)


def api(m, path, sudo=None, ok=(200, 201, 204), **kw):
    h = {'Sudo': sudo} if sudo else {}
    r = s.request(m, API + path, headers=h, timeout=120, **kw)
    if r.status_code not in ok: raise RuntimeError(f'{m} {path} -> {r.status_code} {r.text[:300]}')
    return r.json() if r.text and r.text.strip()[:1] in '[{' else None


def readme(owner, name, desc, lang):
    return f"""# {name}

{desc}.

## Getting started

```sh
git clone http://git.farm.test/{owner}/{name}.git
cd {name}
make setup
make run
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `{R.choice([3000, 8080, 8000, 5000])}` | HTTP port |
| `LOG_LEVEL` | `info` | Log verbosity |
| `REGION` | `{R.choice(['ap-south-1', 'eu-west-1', 'us-east-1'])}` | Deployment region |

## Contributing

Open an issue first for big changes. Run `make test` before you push. Written in {lang}.

## Maintainers

{', '.join(R.sample(USERS[1:], 2))}
"""


def main():
    for i, (first, last) in enumerate(NAMES):
        u = USERS[i]
        api('POST', '/admin/users', ok=(201, 422), json={'username': u, 'email': f'{u}@farm.test', 'password': PASSWORD, 'full_name': f'{first} {last}',
                                                       'must_change_password': False, 'send_notify': False})
        api('PATCH', f'/admin/users/{u}', json={'login_name': u, 'source_id': 0, 'location': R.choice(['Pune', 'Bengaluru', 'Mumbai', 'Delhi', 'Lisbon', 'Tokyo', 'Berlin']),
                                               'website': f'https://{u.split(".")[0]}.dev.test', 'description': R.choice(['Backend engineer', 'Frontend engineer', 'SRE', 'Product engineer', 'Mobile developer', 'Data engineer', 'Engineering manager'])})
    members = {}
    for org, full, desc in ORGS:
        api('POST', '/orgs', ok=(201, 422), json={'username': org, 'full_name': full, 'description': desc, 'visibility': 'public'})
        team = api('POST', f'/orgs/{org}/teams', ok=(201, 422), json={'name': 'developers', 'permission': 'write', 'includes_all_repositories': True,
                                                                         'units': ['repo.code', 'repo.issues', 'repo.pulls', 'repo.releases', 'repo.wiki']})
        if not team: team = [t for t in api('GET', f'/orgs/{org}/teams') if t['name'] == 'developers'][0]
        ms = [ME] + R.sample(USERS[1:], 12)
        members[org] = ms
        for u in ms: api('PUT', f'/teams/{team["id"]}/members/{u}')
        if org != 'monsoon-retail':  # the persona administers two of the three orgs
            owners = [t for t in api('GET', f'/orgs/{org}/teams') if t['name'].lower() == 'owners'][0]
            api('PUT', f'/teams/{owners["id"]}/members/{ME}')
    members[ME] = [ME] + R.sample(USERS[1:], 3)
    n_issues = n_prs = n_comments = 0
    for owner, name, desc, lang in REPOS:
        path = f'/orgs/{owner}/repos' if owner != ME else '/user/repos'
        api('POST', path, sudo=ME if owner == ME else None, ok=(201, 409), json={'name': name, 'description': desc, 'auto_init': True, 'readme': 'Default',
                                                                                 'license': R.choice(['MIT', 'Apache-2.0']), 'issue_labels': 'Default', 'default_branch': 'main'})
        base = f'/repos/{owner}/{name}'
        if owner == ME:
            for u in members[ME][1:]: api('PUT', f'{base}/collaborators/{u}', json={'permission': 'write'})
        cur = api('GET', f'{base}/contents/README.md')
        fname, code = EXT[lang]
        api('POST', f'{base}/contents', sudo=ME, json={'message': 'Add README, docs and code skeleton', 'branch': 'main', 'files': [
            {'operation': 'update', 'path': 'README.md', 'sha': cur['sha'], 'content': base64.b64encode(readme(owner, name, desc, lang).encode()).decode()},
            {'operation': 'create', 'path': fname, 'content': base64.b64encode(code.replace('{name}', name).encode()).decode()},
            {'operation': 'create', 'path': 'docs/CONTRIBUTING.md', 'content': base64.b64encode(b'# Contributing\n\n1. Fork the repo\n2. Create a branch\n3. Open a pull request\n').decode()},
            {'operation': 'create', 'path': 'CHANGELOG.md', 'content': base64.b64encode(f'# Changelog\n\n## 1.{R.randint(1, 9)}.0\n- First public release\n'.encode()).decode()}]})
        api('PUT', f'{base}/topics', json={'topics': R.sample(['api', 'mobile', 'web', 'cli', 'retail', 'devops', 'sync', 'india', 'open-source', 'payments'], 3)})
        for ln, col in [('priority: high', '#e11d21'), ('priority: low', '#c2e0c6'), ('good first issue', '#7057ff'), ('documentation', '#0075ca'), ('needs review', '#fbca04')]:
            api('POST', f'{base}/labels', ok=(201, 409, 422), json={'name': ln, 'color': col})
        labels = {l['name']: l['id'] for l in api('GET', f'{base}/labels?limit=50')}
        ms_ids = []
        for title in R.sample(['v1.2', 'v1.3', 'v2.0', 'Q4 cleanup', 'Diwali sale', 'Beta'], 3):
            m = api('POST', f'{base}/milestones', json={'title': title, 'description': f'Work planned for {title}', 'due_on': f'2026-{R.randint(10, 12):02d}-{R.randint(1, 28):02d}T12:00:00Z'})
            ms_ids.append(m['id'])
        people = members[owner]
        for k in range(R.randint(13, 19)):
            bug = R.random() < 0.55
            title = f(R.choice(BUGS if bug else FEATURES))
            title = title[0].upper() + title[1:]
            lab = [labels['bug' if bug else 'enhancement']] + [labels[x] for x in R.sample(['priority: high', 'priority: low', 'good first issue', 'documentation', 'help wanted', 'question'], R.choice([0, 1, 1, 2]))]
            author = R.choice(people)
            issue = api('POST', f'{base}/issues', sudo=author, json={'title': title, 'body': f(R.choice(BODIES)), 'labels': lab,
                                                                     'assignees': R.sample(people, R.choice([0, 1, 1, 1, 2])), 'milestone': R.choice(ms_ids + [0, 0])})
            n_issues += 1
            for _ in range(R.choice([0, 0, 1, 1, 2, 3, 4])):
                api('POST', f'{base}/issues/{issue["number"]}/comments', sudo=R.choice(people), json={'body': f(R.choice(COMMENTS))})
                n_comments += 1
            if R.random() < 0.3: api('PATCH', f'{base}/issues/{issue["number"]}', json={'state': 'closed'})
        for k in range(2):
            author = R.choice(people)
            br = f'{author.split(".")[0]}/{R.choice(["fix", "feat", "chore"])}-{R.randint(100, 999)}'
            api('POST', f'{base}/contents', sudo=author, json={'message': f(R.choice(PRS)), 'branch': 'main', 'new_branch': br, 'files': [
                {'operation': 'create', 'path': f'notes/{br.replace("/", "-")}.md', 'content': base64.b64encode(f'Notes for {br}\n'.encode()).decode()}]})
            pr = api('POST', f'{base}/pulls', sudo=author, json={'title': f(R.choice(PRS)), 'head': br, 'base': 'main', 'body': f'Closes #{R.randint(1, 12)}.\n\n' + f(R.choice(BODIES)),
                                                                 'assignees': R.sample(people, 1), 'labels': [labels[x] for x in R.sample(list(labels), 1)]})
            n_prs += 1
            for _ in range(R.choice([0, 1, 2, 3])):
                api('POST', f'{base}/issues/{pr["number"]}/comments', sudo=R.choice(people), json={'body': R.choice(['LGTM', 'Can you add a test?', 'Nice cleanup.', 'Please rebase on main.', 'Approved after the fix.'])})
                n_comments += 1
            if k == 0 and R.random() < 0.4:
                api('POST', f'{base}/pulls/{pr["number"]}/merge', ok=(200, 204, 405, 409), json={'Do': 'merge'})
        for u in R.sample(USERS, R.randint(2, 14)):
            api('PUT', f'/user/starred/{owner}/{name}', sudo=u)
    print(json.dumps({'users': len(USERS), 'orgs': len(ORGS), 'repos': len(REPOS), 'issues': n_issues, 'prs': n_prs, 'comments': n_comments}))


if __name__ == '__main__':
    main()
