#!/usr/bin/env python3
"""Shared synthetic content for the social clones (Akkoma, Lemmy, HumHub). No real people.

People, topics, posts, replies, forum threads and comments, built from templates with a fixed seed
so every rebuild of a seed gives the same names and texts.
"""
import random

FIRST = ['Asha', 'Rohan', 'Meera', 'Kabir', 'Priya', 'Arjun', 'Neha', 'Vikram', 'Isha', 'Dev', 'Ananya', 'Karan', 'Tara', 'Nikhil', 'Sana', 'Rahul',
         'Leela', 'Aditya', 'Zoya', 'Farhan', 'Diya', 'Omar', 'Ritu', 'Samir', 'Pooja', 'Varun', 'Kavya', 'Imran', 'Nisha', 'Yash', 'Maya', 'Tenzin',
         'Elena', 'Lucas', 'Hana', 'Mateo', 'Grace', 'Noah', 'Amara', 'Felix', 'Ines', 'Kenji', 'Lars', 'Chloe', 'Sipho', 'Ravi', 'Aisha', 'Jonas']
LAST = ['Rao', 'Mehta', 'Iyer', 'Khan', 'Nair', 'Sharma', 'Das', 'Kapoor', 'Joshi', 'Bose', 'Pillai', 'Singh', 'Menon', 'Reddy', 'Gupta', 'Ali',
        'Fernandes', 'Chatterjee', 'Kulkarni', 'Banerjee', 'Shah', 'Verma', 'Patel', 'Rossi', 'Silva', 'Tanaka', 'Okafor', 'Novak', 'Berg', 'Moreau',
        'Dubois', 'Sato', 'Larsen', 'Haddad', 'Mbeki', 'Kumar', 'Qureshi', 'Weber']
CITIES = ['Pune', 'Bengaluru', 'Mumbai', 'Delhi', 'Hyderabad', 'Chennai', 'Goa', 'Jaipur', 'Kochi', 'Kolkata', 'Lisbon', 'Berlin', 'Tokyo', 'Nairobi', 'Toronto', 'Singapore']
JOBS = ['Product Manager', 'Software Engineer', 'Data Scientist', 'UX Designer', 'Marketing Lead', 'Sales Director', 'DevOps Engineer', 'Founder',
        'Financial Analyst', 'HR Business Partner', 'Content Strategist', 'Mobile Developer', 'Security Engineer', 'Operations Manager', 'Chef',
        'Photographer', 'Teacher', 'Journalist', 'Architect', 'Doctor', 'Research Scientist', 'Customer Success Manager', 'QA Engineer', 'CTO']
COMPANIES = ['Northwind Labs', 'Acme Pay', 'Brightdesk', 'Skyroute', 'Greenleaf Foods', 'Pixelforge', 'Bluefin Health', 'Orbit Logistics',
             'Monsoon Media', 'Tiger Analytics Co', 'Lotus Bank', 'Cedar Schools', 'Quill Press', 'Helix Bio', 'Kite Mobility', 'Saffron Studios']

TOPICS = {
    'cricket': {'tags': ['cricket', 'IPL', 'TeamIndia'], 'things': ['the final over', 'that cover drive', 'the spin attack', 'the toss call', 'a five-wicket haul', 'the powerplay', 'the run chase', 'the DRS review'],
                'lines': ['What a match! {thing} decided it.', 'Still thinking about {thing} from last night.', 'Hot take: {thing} was the turning point.', 'Can we talk about {thing}? Unreal.', 'Rain delay again. At least we got {thing} before the break.']},
    'food': {'tags': ['food', 'cooking', 'recipes'], 'things': ['masala dosa', 'a one-pot biryani', 'filter coffee', 'sourdough', 'rasam', 'pav bhaji', 'ramen', 'mango lassi', 'paneer tikka'],
             'lines': ['Made {thing} from scratch today. Worth every minute.', 'Best {thing} in {city}? Recommendations please.', 'Unpopular opinion: {thing} tastes better the next day.', 'Tried a new recipe for {thing}. Notes in the replies.', 'Sunday plan: {thing} and a long nap.']},
    'travel': {'tags': ['travel', 'wanderlust', 'roadtrip'], 'things': ['the Konkan coast', 'Ladakh', 'Hampi', 'Lisbon', 'Kyoto', 'the Western Ghats', 'Meghalaya', 'Rishikesh', 'the Spiti valley'],
               'lines': ['Just back from {thing}. Already planning the next trip.', 'Train window views on the way to {thing} are unbeatable.', 'Packing list for {thing}: fewer clothes, more snacks.', 'Anyone been to {thing} in the monsoon? Worth it?', 'Sunrise at {thing}. No filter needed.']},
    'ai': {'tags': ['AI', 'MachineLearning', 'LLM'], 'things': ['small language models', 'on-device inference', 'RAG pipelines', 'model evals', 'fine-tuning', 'agent benchmarks', 'quantisation', 'vector search'],
           'lines': ['Spent the day on {thing}. The results surprised me.', 'Thread: what I learned about {thing} this month.', 'Everyone talks about {thing}, few measure it.', '{thing} is getting cheaper every week.', 'Reading list on {thing}, all free.']},
    'startups': {'tags': ['startups', 'founders', 'SaaS'], 'things': ['the seed round', 'our first 100 customers', 'pricing pages', 'cold email', 'hiring the first engineer', 'churn', 'a product launch', 'the pivot'],
                 'lines': ['Lesson from {thing}: talk to users every week.', 'Nobody warns you about {thing}.', 'We shipped {thing} today. Small team, big week.', 'Ask me anything about {thing}.', 'Three mistakes we made with {thing}.']},
    'climate': {'tags': ['climate', 'sustainability', 'solar'], 'things': ['rooftop solar', 'the heatwave', 'composting', 'EV charging', 'water harvesting', 'urban trees', 'the monsoon forecast'],
                'lines': ['Our society installed {thing}. Bills are down already.', 'Data on {thing} this year is worrying.', 'Small win: {thing} at our office.', 'Explainer on {thing}, in plain words.', 'Why {thing} matters for {city}.']},
    'books': {'tags': ['books', 'reading', 'bookclub'], 'things': ['a new mystery novel', 'a history of spices', 'a slim poetry book', 'a sci-fi trilogy', 'a memoir about chess', 'an essay collection'],
              'lines': ['Finished {thing} in two sittings.', 'Book club pick this month: {thing}.', 'Halfway through {thing} and hooked.', 'Recommend me something like {thing}.', 'Re-reading {thing}. Better the second time.']},
    'music': {'tags': ['music', 'concerts', 'playlist'], 'things': ['a Carnatic concert', 'an indie gig', 'the jazz festival', 'a lo-fi playlist', 'a sitar recital', 'a vinyl find'],
              'lines': ['Went to {thing} last night. Goosebumps.', 'My focus playlist is mostly {thing} now.', 'Found {thing} in a market in {city}.', '{thing} this weekend, who is in?', 'Nothing beats {thing} on a rainy evening.']},
    'photography': {'tags': ['photography', 'streetphotography', 'nature'], 'things': ['golden hour', 'a 35mm prime', 'street portraits', 'monsoon clouds', 'night skies', 'film photography'],
                    'lines': ['Shot {thing} in {city} today.', 'Tip: {thing} needs patience, not gear.', 'Trying {thing} for a month. Day 1.', 'My favourite frame from {thing} this week.', 'Learning {thing} from scratch.']},
    'fitness': {'tags': ['fitness', 'running', 'yoga'], 'things': ['a 10K run', 'morning yoga', 'a half marathon', 'strength training', 'a cycling loop', 'a long hike'],
                'lines': ['Did {thing} before work. Feeling great.', 'Training for {thing}. Week 3.', '{thing} in {city} heat is no joke.', 'Rest day after {thing}.', 'New personal best on {thing}!']},
    'remote': {'tags': ['remotework', 'productivity', 'WFH'], 'things': ['async standups', 'deep work blocks', 'a standing desk', 'meeting-free Fridays', 'shared docs', 'time zones'],
               'lines': ['Our team tried {thing}. Never going back.', 'Hot take: {thing} beats more meetings.', '{thing} changed how I plan my week.', 'How do you handle {thing}?', 'Small habit, big effect: {thing}.']},
    'gaming': {'tags': ['gaming', 'indiegames', 'esports'], 'things': ['a cozy farming game', 'a roguelike', 'the esports final', 'a retro console', 'a puzzle game', 'co-op night'],
               'lines': ['Lost my whole weekend to {thing}.', '{thing} is criminally underrated.', 'Watching {thing} with friends tonight.', 'Speedrunning {thing}. Wish me luck.', 'Any recs like {thing}?']},
}

REPLIES = ['Totally agree!', 'Same here, {first}.', 'This is so true.', 'Love this.', 'Interesting take. Not sure I agree though.', 'Saving this for later.',
           'Where was this?', 'Great point.', 'Ha, been there.', 'Thanks for sharing!', 'Can you share more details?', 'This made my day.',
           'Hard disagree, but respect.', 'Following for updates.', '+1, especially the last part.', 'We tried this too. It works.', 'Congrats!', 'Tell me more about {thing}.']

COMMUNITIES = [
    ('technology', 'Technology', 'News and talk about tech, gadgets and software.', 'ai'),
    ('cricket', 'Cricket', 'Matches, players, stats and banter.', 'cricket'),
    ('cooking', 'Cooking', 'Recipes, kitchen tips and food photos.', 'food'),
    ('travel', 'Travel', 'Trip reports, itineraries and travel questions.', 'travel'),
    ('startups', 'Startups', 'Founders, funding, growth and product.', 'startups'),
    ('books', 'Books', 'What are you reading?', 'books'),
    ('climate', 'Climate', 'Climate news and sustainable living.', 'climate'),
    ('photography', 'Photography', 'Gear, technique and critique.', 'photography'),
    ('fitness', 'Fitness', 'Running, lifting, yoga and recovery.', 'fitness'),
    ('gaming', 'Gaming', 'Games of every kind.', 'gaming'),
    ('music', 'Music', 'Gigs, albums and playlists.', 'music'),
    ('workfromhome', 'Work From Home', 'Remote work, tools and habits.', 'remote'),
]

TITLES = ['What is your take on {thing}?', 'I tried {thing} for 30 days. Here is what happened', 'Beginner question about {thing}',
          'Is {thing} overrated?', '{thing}: a short guide', 'Best resources for {thing}?', 'Unpopular opinion about {thing}',
          'Weekly thread: {thing}', 'My experience with {thing} in {city}', 'Help: stuck with {thing}', 'Why {thing} matters more than you think',
          'Share your favourite {thing} moments', 'Photo: {thing} this weekend', 'News: big changes coming to {thing}']
BODIES = ['I have been thinking about {thing} a lot lately. Curious what this community thinks.', 'Long-time lurker, first post. {line}',
          '{line} Would love to hear your experiences.', 'Quick summary: {line} Details below in the comments.', '{line}\n\nEdit: thanks for all the replies!',
          'Context: I live in {city}. {line}']
COMMENTS = ['This is the answer.', 'Great write-up, thanks.', 'I disagree. {thing} works fine for me.', 'Same experience here in {city}.',
            'Source?', 'Underrated comment.', 'Came here to say this.', 'Have you tried {thing}?', 'Bookmarking this thread.',
            'Not sure about that, but interesting.', 'This should be pinned.', 'Followed your advice and it worked!', 'Can confirm.',
            'Thanks, this helped a lot.', 'Ha, classic.', 'Any update on this?', 'Lots of good points here.', 'Upvoted for visibility.']


def people(n, seed=20261016):
    """n fake people with nick, name, bio, job, company, city. The first is the main persona."""
    r = random.Random(seed)
    out, used = [], set()
    for i in range(n):
        first, last = FIRST[i % len(FIRST)], LAST[(i * 7 + i // len(FIRST)) % len(LAST)]
        nick = f'{first.lower()}_{last.lower()}'
        while nick in used:
            nick += str(i)
        used.add(nick)
        topics = r.sample(sorted(TOPICS), 3)
        job, company, city = r.choice(JOBS), r.choice(COMPANIES), r.choice(CITIES)
        out.append({'nick': nick, 'first': first, 'last': last, 'name': f'{first} {last}', 'email': f'{nick.replace("_", ".")}@farm.test',
                    'job': job, 'company': company, 'city': city, 'topics': topics,
                    'bio': f'{job} at {company}. {city}. Into {topics[0]}, {topics[1]} and {topics[2]}.'})
    return out


def post_text(r, person, topic=None, tags=True):
    topic = topic or r.choice(person['topics'] + [r.choice(sorted(TOPICS))])
    t = TOPICS[topic]
    thing = r.choice(t['things'])
    text = r.choice(t['lines']).format(thing=thing, city=person['city'])
    text = text[0].upper() + text[1:]
    if tags and r.random() < 0.7:
        text += ' ' + ' '.join('#' + x for x in r.sample(t['tags'], r.randint(1, 2)))
    return topic, text


def reply_text(r, author, topic):
    thing = r.choice(TOPICS[topic]['things'])
    return r.choice(REPLIES).format(first=author['first'], thing=thing)


def thread(r, person, topic):
    t = TOPICS[topic]
    thing = r.choice(t['things'])
    line = r.choice(t['lines']).format(thing=thing, city=person['city'])
    title = r.choice(TITLES).format(thing=thing, city=person['city'])
    body = r.choice(BODIES).format(thing=thing, line=line[0].upper() + line[1:], city=person['city'])
    return title[0].upper() + title[1:], body


def comment_text(r, person, topic):
    return r.choice(COMMENTS).format(thing=r.choice(TOPICS[topic]['things']), city=person['city'])
