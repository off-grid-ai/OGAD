#!/usr/bin/env python3
"""Seed Lemmy (forum.farm.test) through its own API: open the site, 30 users, 12 communities,
600+ posts, 3000+ comments (threaded), votes, subscriptions. Then spreads dates over 60 days in SQL.

  python3 lemmy_seed.py            (lemmy_server must be running on 127.0.0.1:7141, fresh DB)
"""
import json, os, random, subprocess, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from social_content import people, thread, comment_text, COMMUNITIES  # noqa: E402

PW = json.load(open(os.path.join(HERE, '..', 'farm', 'accounts.json')))['password']
API = 'http://127.0.0.1:7141/api/v3'
R = random.Random(7)
PEOPLE = people(30, seed=99)


def req(method, path, jwt=None, data=None):
    r = urllib.request.Request(API + path, data=json.dumps(data).encode() if data is not None else None, method=method,
                               headers={'Content-Type': 'application/json', 'Host': 'forum.farm.test'})
    if jwt:
        r.add_header('Authorization', f'Bearer {jwt}')
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return json.loads(resp.read() or 'null')
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'{method} {path}: {e.code} {e.read()[:200]}')


def login(user):
    return req('POST', '/user/login', data={'username_or_email': user, 'password': PW})['jwt']


def sql(q):
    return subprocess.run(['su', 'postgres', '-c', f'psql -d lemmy -tAc "{q}"'], capture_output=True, text=True)


def main():
    admin = login('farmadmin')
    big = 999999
    req('PUT', '/site', admin, {'registration_mode': 'Open', 'captcha_enabled': False, 'require_email_verification': False,
                                'federation_enabled': False, 'description': 'Threadly: communities for everything.',
                                'sidebar': 'Be kind. Stay on topic. Have fun.', 'application_question': None,
                                'rate_limit_message': big, 'rate_limit_post': big, 'rate_limit_register': big, 'rate_limit_comment': big,
                                'rate_limit_search': big, 'rate_limit_image': big, 'rate_limit_message_per_second': 1, 'rate_limit_post_per_second': 1,
                                'rate_limit_register_per_second': 1, 'rate_limit_comment_per_second': 1, 'rate_limit_search_per_second': 1, 'rate_limit_image_per_second': 1})
    jwt = {}
    for p in PEOPLE:
        try:
            jwt[p['nick']] = req('POST', '/user/register', data={'username': p['nick'], 'password': PW, 'password_verify': PW, 'show_nsfw': False})['jwt']
        except RuntimeError as e:
            print('register', p['nick'], e, flush=True)
            jwt[p['nick']] = login(p['nick'])
        req('PUT', '/user/save_user_settings', jwt[p['nick']], {'bio': p['bio'], 'display_name': p['name']})
    print('users', len(jwt), flush=True)
    comm = {}
    for i, (name, title, desc, topic) in enumerate(COMMUNITIES):
        mod = PEOPLE[(i * 3 + 1) % len(PEOPLE)]
        c = req('POST', '/community', jwt[mod['nick']], {'name': name, 'title': title, 'description': desc})
        comm[name] = (c['community_view']['community']['id'], topic)
    me = PEOPLE[0]['nick']
    subs = [(p['nick'], name) for p in PEOPLE for name in R.sample(sorted(comm), R.randint(3, 8)) if not (p['nick'] == me and name in ('gaming', 'music', 'climate', 'fitness'))]
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(lambda s: req('POST', '/community/follow', jwt[s[0]], {'community_id': comm[s[1]][0], 'follow': True}), subs))
    print('subs', len(subs), flush=True)
    posts = []

    def mkpost(i):
        name = R.choice(sorted(comm))
        cid, topic = comm[name]
        author = R.choice(PEOPLE)
        title, body = thread(R, author, topic)
        pv = req('POST', '/post', jwt[author['nick']], {'name': title, 'community_id': cid, 'body': body})
        return pv['post_view']['post']['id'], author['nick'], topic
    for start in range(0, 660, 16):
        with ThreadPoolExecutor(16) as ex:
            posts += list(ex.map(mkpost, range(start, min(start + 16, 660))))
    print('posts', len(posts), flush=True)
    comments = []

    def mkcomment(item):
        pid, topic, parent = item
        author = R.choice(PEOPLE)
        data = {'content': comment_text(R, author, topic), 'post_id': pid}
        if parent:
            data['parent_id'] = parent
        cv = req('POST', '/comment', jwt[author['nick']], data)
        return pid, topic, cv['comment_view']['comment']['id']
    batch = []
    for n in range(3300):
        if comments and R.random() < 0.4:
            pid, topic, cid = R.choice(comments[-300:])
            batch.append((pid, topic, cid))
        else:
            pid, _, topic = R.choice(posts)
            batch.append((pid, topic, None))
        if len(batch) == 16:
            with ThreadPoolExecutor(16) as ex:
                comments += list(ex.map(mkcomment, batch))
            batch = []
    print('comments', len(comments), flush=True)
    votes = []
    for pid, nick, topic in posts:
        for p in R.sample(PEOPLE, R.choice([0, 1, 2, 3, 5, 8, 12])):
            if p['nick'] != nick:
                votes.append(('/post/like', {'post_id': pid, 'score': 1 if R.random() < 0.85 else -1}, p['nick']))
    for pid, topic, cid in comments:
        for p in R.sample(PEOPLE, R.choice([0, 0, 1, 2, 4])):
            votes.append(('/comment/like', {'comment_id': cid, 'score': 1 if R.random() < 0.85 else -1}, p['nick']))
    with ThreadPoolExecutor(16) as ex:
        list(ex.map(lambda v: req('POST', v[0], jwt[v[2]], v[1]), votes))
    print('votes', len(votes), flush=True)
    # Spread dates over 60 days, keeping order (older ids = older dates).
    for q in ["update post set published = now() - ((select max(id) from post) - id) * interval '130 minutes'",
              "update post_aggregates pa set published = p.published from post p where p.id = pa.post_id",
              "update comment c set published = p.published + (c.id % 97) * interval '7 minutes' from post p where p.id = c.post_id",
              "update comment_aggregates ca set published = c.published from comment c where c.id = ca.comment_id",
              "update post_aggregates pa set newest_comment_time = coalesce((select max(published) from comment c where c.post_id = pa.post_id), pa.published), newest_comment_time_necro = coalesce((select max(published) from comment c where c.post_id = pa.post_id), pa.published)",
              "update post_aggregates set hot_rank = r.hot_rank(score::numeric, published), hot_rank_active = r.hot_rank(score::numeric, newest_comment_time_necro), scaled_rank = r.scaled_rank(score::numeric, published, 10)",
              "update comment_aggregates set hot_rank = r.hot_rank(score::numeric, published)"]:
        r = sql(q)
        print(q[:50], r.stdout.strip(), r.stderr.strip()[:200], flush=True)


if __name__ == '__main__':
    main()
