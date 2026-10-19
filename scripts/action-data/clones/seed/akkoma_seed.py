#!/usr/bin/env python3
"""Seed Akkoma (social.farm.test) through its own CLI and Mastodon API: 40 users with bios, follows,
3000+ posts with hashtags, replies, likes and boosts. Then spreads post dates over 60 days in SQL.

  python3 akkoma_seed.py            (Akkoma must be running on 127.0.0.1:7140, empty DB)
"""
import json, os, time, random, subprocess, sys, urllib.request, urllib.parse
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from social_content import people, post_text, reply_text, TOPICS  # noqa: E402

PW = json.load(open(os.path.join(HERE, '..', 'farm', 'accounts.json')))['password']
API = 'http://127.0.0.1:7140'
CTL = '/opt/clone-farm/akkoma/release/bin/pleroma_ctl'
ENV = dict(os.environ, AKKOMA_CONFIG_PATH='/opt/clone-farm/akkoma/config.exs')
R = random.Random(42)
PEOPLE = people(40)


def req(method, path, token=None, data=None, tries=6):
    for t in range(tries):
        try:
            return _req(method, path, token, data)
        except urllib.error.HTTPError as e:
            if e.code < 500 or t == tries - 1:
                raise
            time.sleep(0.3 * (t + 1))


def _req(method, path, token=None, data=None):
    body = urllib.parse.urlencode(data, doseq=True).encode() if data is not None else None
    r = urllib.request.Request(API + path, data=body, method=method, headers={'Host': 'social.farm.test'})
    if token:
        r.add_header('Authorization', f'Bearer {token}')
    with urllib.request.urlopen(r, timeout=60) as resp:
        return json.loads(resp.read() or 'null')


def ctl(*args):
    return subprocess.run([CTL, *args], env=ENV, capture_output=True, text=True, cwd='/opt/clone-farm/akkoma')


def main():
    for p in PEOPLE + [{'nick': 'farmadmin', 'email': 'farmadmin@farm.test', 'name': 'Farm Admin'}]:
        r = ctl('user', 'new', p['nick'], p['email'], '--password', PW, *(['--admin'] if p['nick'] == 'farmadmin' else []), '-y')
        print(p['nick'], (r.stdout + r.stderr).strip().splitlines()[-1:] if r.returncode else 'ok', flush=True)
    app = req('POST', '/api/v1/apps', data={'client_name': 'farm-seed', 'redirect_uris': 'urn:ietf:wg:oauth:2.0:oob', 'scopes': 'read write follow'})
    tok = {}
    for p in PEOPLE:
        t = req('POST', '/oauth/token', data={'grant_type': 'password', 'client_id': app['client_id'], 'client_secret': app['client_secret'],
                                              'username': p['nick'], 'password': PW, 'scope': 'read write follow'})
        tok[p['nick']] = t['access_token']
    ids = {}

    def profile(p):
        a = req('PATCH', '/api/v1/accounts/update_credentials', tok[p['nick']], {
            'note': p['bio'], 'display_name': p['name'],
            'fields_attributes[0][name]': 'Works at', 'fields_attributes[0][value]': p['company'],
            'fields_attributes[1][name]': 'City', 'fields_attributes[1][value]': p['city']})
        ids[p['nick']] = a['id']
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(profile, PEOPLE))
    # Follows: everyone follows 8-18 others.
    pairs = [(p['nick'], q['nick']) for p in PEOPLE for q in R.sample([x for x in PEOPLE if x is not p], R.randint(8, 18))]
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(lambda pq: req('POST', f'/api/v1/accounts/{ids[pq[1]]}/follow', tok[pq[0]]), pairs))
    print('follows', len(pairs), flush=True)
    # Posts in rounds of 16 so ids (and dates) increase over time.
    posts = []  # (id, nick, topic)
    plan = []
    for i in range(3200):
        author = R.choice(PEOPLE)
        if posts and R.random() < 0.35:
            pid, pnick, topic = R.choice(posts[-400:])
            plan.append((author, topic, pid))
        else:
            plan.append((author, None, None))
        if len(plan) == 16 or i == 3199:
            def one(item):
                author, topic, parent = item
                if parent:
                    st = req('POST', '/api/v1/statuses', tok[author['nick']], {'status': reply_text(R, author, topic), 'in_reply_to_id': parent, 'visibility': 'public'})
                else:
                    topic, text = post_text(R, author)
                    st = req('POST', '/api/v1/statuses', tok[author['nick']], {'status': text, 'visibility': 'public'})
                return st['id'], author['nick'], topic
            with ThreadPoolExecutor(16) as ex:
                posts += list(ex.map(one, plan))
            plan = []
            if len(posts) % 400 == 0:
                print('posts', len(posts), flush=True)
    # Likes and boosts, by people who care about the topic (mostly).
    acts = []
    for pid, nick, topic in posts:
        fans = [p for p in PEOPLE if p['nick'] != nick and (topic in p['topics'] or R.random() < 0.1)]
        for p in R.sample(fans, min(len(fans), R.choice([0, 0, 1, 1, 2, 3, 4, 6, 9]))):
            acts.append(('favourite', pid, p['nick']))
        if R.random() < 0.18 and fans:
            acts.append(('reblog', pid, R.choice(fans)['nick']))
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(lambda a: req('POST', f'/api/v1/statuses/{a[1]}/{a[0]}', tok[a[2]]), acts))
    print('likes+boosts', len(acts), flush=True)


if __name__ == '__main__':
    main()
