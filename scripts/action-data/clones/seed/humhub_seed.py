#!/usr/bin/env python3
"""Plan for the HumHub seed (people.farm.test, a LinkedIn/Facebook-like network). Writes JSON that
humhub_seed.php (a Yii console controller) turns into real HumHub users, spaces, posts, comments,
likes, follows and friendships through HumHub's own models.

  python3 humhub_seed.py /dev/shm/clone-farm/humhub-seed.json
"""
import json, os, random, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from social_content import people, post_text, reply_text, TOPICS  # noqa: E402

R = random.Random(314)
PEOPLE = people(40, seed=2718)
SPACES = [
    ('Product Guild', 'Product managers sharing roadmaps, research and launch notes.', ['startups', 'remote']),
    ('Engineering', 'Builds, reviews, incidents and tech talks.', ['ai', 'remote']),
    ('Design Crew', 'UX, UI and research crits.', ['photography', 'remote']),
    ('Marketing Hub', 'Campaigns, content and brand.', ['startups', 'music']),
    ('Data and AI', 'Models, dashboards and experiments.', ['ai', 'startups']),
    ('Remote Workers', 'Tips and support for distributed teams.', ['remote', 'travel']),
    ('Book Club', 'One book a month, one long thread.', ['books']),
    ('Pune Runners', 'Weekend runs and race plans.', ['fitness']),
    ('Founders Circle', 'Fundraising, hiring and growth.', ['startups']),
    ('Foodies', 'Recipes and restaurant finds.', ['food', 'travel']),
    ('Climate Action', 'Sustainability at work and home.', ['climate']),
    ('Hiring and Careers', 'Open roles, referrals and career advice.', ['startups', 'remote']),
]
PRO = ['Excited to share that our team just shipped {thing}. Proud of everyone involved.',
       'We are hiring! Looking for a {job} to join {company} in {city}. DM me for a referral.',
       'Three lessons from a year of {thing}: listen more, ship smaller, measure everything.',
       'Grateful to have spoken about {thing} at a meetup in {city} last week.',
       'Celebrating 5 years at {company} today. Thank you to the best team.',
       'New article: what {thing} taught me about leadership.',
       'Our {company} offsite in {city} was a blast. Great ideas on {thing}.',
       'Looking for recommendations: best tools for {thing}?',
       'Happy to announce I have joined {company} as {job}!',
       'Quick poll for my network: how does your team handle {thing}?']


def main(out):
    plan = {'users': [], 'spaces': [], 'posts': [], 'follows': [], 'friends': []}
    for p in PEOPLE:
        plan['users'].append({'username': p['nick'], 'email': p['email'], 'first': p['first'], 'last': p['last'],
                              'title': f"{p['job']} at {p['company']}", 'city': p['city'], 'about': p['bio'], 'topics': p['topics']})
    me = PEOPLE[0]['nick']
    for i, (name, desc, topics) in enumerate(SPACES):
        owner = PEOPLE[(i * 5 + 3) % len(PEOPLE)]['nick']
        members = sorted({x['nick'] for x in R.sample(PEOPLE, R.randint(8, 20))} | {owner})
        if name in ('Pune Runners', 'Climate Action', 'Foodies', 'Marketing Hub'):
            members = [m for m in members if m != me]
        elif name in ('Product Guild', 'Engineering', 'Hiring and Careers'):
            members = sorted(set(members) | {me})
        plan['spaces'].append({'name': name, 'description': desc, 'owner': owner, 'members': members, 'topics': topics})
    nicks = [p['nick'] for p in PEOPLE]
    byNick = {p['nick']: p for p in PEOPLE}
    for n in range(540):
        if R.random() < 0.55:
            sp = R.choice(plan['spaces'])
            author = byNick[R.choice(sp['members'])]
            topic = R.choice(sp['topics'])
            where = {'space': sp['name']}
        else:
            author = R.choice(PEOPLE)
            topic = None
            where = {'user': author['nick']}
        if R.random() < 0.45:
            thing = R.choice(TOPICS[topic or R.choice(author['topics'])]['things'])
            text = R.choice(PRO).format(thing=thing, job=R.choice(['Product Designer', 'Backend Engineer', 'Data Analyst', 'Sales Lead']), company=author['company'], city=author['city'])
            topic = topic or R.choice(author['topics'])
        else:
            topic, text = post_text(R, author, topic)
        comments = []
        for _ in range(R.choice([0, 0, 1, 1, 2, 3, 4, 6])):
            c = byNick[R.choice(nicks)]
            comments.append({'author': c['nick'], 'text': reply_text(R, c, topic), 'likes': R.sample(nicks, R.choice([0, 0, 0, 1, 2]))})
        likes = R.sample(nicks, R.choice([0, 1, 2, 3, 4, 6, 9, 14]))
        plan['posts'].append({'author': author['nick'], **where, 'text': text, 'topic': topic, 'comments': comments, 'likes': [x for x in likes if x != author['nick']]})
    for p in PEOPLE:
        for q in R.sample(PEOPLE, R.randint(4, 12)):
            if q is not p:
                plan['follows'].append([p['nick'], q['nick']])
    pairs = set()
    while len(pairs) < 140:
        a, b = R.sample(nicks, 2)
        if (b, a) not in pairs:
            pairs.add((a, b))
    plan['friends'] = sorted(pairs)
    json.dump(plan, open(out, 'w'), indent=1)
    print('plan', {k: len(v) for k, v in plan.items()}, 'comments', sum(len(p['comments']) for p in plan['posts']))


if __name__ == '__main__':
    main(sys.argv[1])
