#!/usr/bin/env python3
"""Build the LFM3 web-agent training task list (docs/agent-browser/training-tasks.*).

Two parts, in priority order:
  1. Paid-agent jobs: the 12 signed-in jobs the cloud agents (Claude Duet, OpenAI Dots, Grokbot,
     Instinct, Meta Muse) advertise, run on fenced sandbox test accounts (sandbox-profiles.ts).
  2. Common web jobs: 25 things people do on the web x 10 sites each.

Rules it enforces (the build fails if broken):
  - WebVoyager's 15 test sites never appear (the benchmark stays honest).
  - One site per category is held out; a held-out site appears in no training task anywhere.
  - Public-site tasks are read-only: search, filter, compare, read, fill without submitting.
  - Signed-in jobs run only on sandbox profiles, never on real accounts.

Output is the Web Use bench format ({id, goal, url, profile?}) plus labels the pipeline reads:
split (train | holdout), category, stage (1 = read-only public, 2 = needs a sandbox sign-in).

    python3 scripts/agent-browser/build-training-tasks.py            # writes docs/agent-browser/
    python3 scripts/agent-browser/build-training-tasks.py --check    # validate only
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "agent-browser"

# WebVoyager (He et al., 2024): the 15 sites of the benchmark we report on. Never trained on.
WEBVOYAGER = {
    "allrecipes.com": "Allrecipes",
    "amazon.com": "Amazon",
    "apple.com": "Apple",
    "arxiv.org": "ArXiv",
    "bbc.com": "BBC News",
    "bbc.co.uk": "BBC News",
    "booking.com": "Booking.com",
    "dictionary.cambridge.org": "Cambridge Dictionary",
    "coursera.org": "Coursera",
    "espn.com": "ESPN",
    "github.com": "GitHub",
    "google.com": "Google Search, Flights and Maps",
    "huggingface.co": "Hugging Face",
    "wolframalpha.com": "Wolfram Alpha",
}

# Mind2Web-Live test sites we found on our lists. Training on them inflates the Mind2Web eval.
MIND2WEB_LIVE = {"ikea.com", "marriott.com", "newegg.com", "rottentomatoes.com", "soundcloud.com",
                 "target.com", "yelp.com", "last.fm"}

# The ONE holdout shared with the LFM3 new-site task set (ogad-action evals/tasks-newsites-*):
# 25 sites, one per category, Mind2Web-Live-clean. Never trained on, by either set.
SHARED_HOLDOUT = {
    "search.brave.com", "bestbuy.com", "apnews.com", "worldometers.info", "yr.no",
    "viamichelin.com", "auspost.com.au", "momondo.com", "hyatt.com", "grubhub.com", "citi.com",
    "reed.co.uk", "issuu.com", "calendarlabs.com", "sitejabber.com", "askubuntu.com", "setlist.fm",
    "futurelearn.com", "servicesaustralia.gov.au", "budgetbytes.com", "marketwatch.com", "tuta.com",
    "mastodon.social", "viber.com", "tubi.tv",
}

# ---------------------------------------------------------------------------------------------
# Part 1: the 12 paid-agent jobs, on sandbox profiles.
# ---------------------------------------------------------------------------------------------

PAID_JOBS = [
    {
        "job": "email",
        "title": "Email: triage, reply, follow up",
        "advertised_by": ["Claude Duet", "OpenAI Dots", "Grokbot", "Instinct", "Meta Muse"],
        "profile": "mail",
        "tasks": [
            "Find the three most recent unread emails and summarise each in one line.",
            "Reply to the latest email from Priya Shah saying Thursday at 3pm works, then send it.",
            "Find every email about the 'Q3 offsite' and move them to a folder named Offsite.",
            "Flag every email that asks a question I have not answered.",
            "Forward the invoice email from Northwind Supplies to accounts@offgrid-mail.test.",
            "Draft a polite follow-up to the vendor who has not replied in a week; save it as a draft, do not send.",
            "Archive all newsletters older than seven days.",
            "Find the tracking number in the shipping confirmation email and report it.",
        ],
    },
    {
        "job": "calendar",
        "title": "Calendar: schedule and move meetings",
        "advertised_by": ["Claude Duet", "OpenAI Dots", "Grokbot", "Instinct", "Meta Muse"],
        "profile": "calendar",
        "tasks": [
            "Create a 30-minute meeting called 'Design review' next Tuesday at 11am.",
            "Move tomorrow's 'Standup' to 10:30 and keep everything else the same.",
            "Find a free one-hour slot on Friday afternoon and book 'Focus time' in it.",
            "List every meeting next week that has more than five attendees.",
            "Cancel the 'Lunch with Sam' event on Wednesday.",
            "Add a reminder 15 minutes before every meeting tomorrow.",
            "Invite dev@offgrid-mail.test to the 'Sprint planning' event.",
        ],
    },
    {
        "job": "forms",
        "title": "Fill in forms and applications",
        "advertised_by": ["Grokbot", "Meta Muse"],
        "profile": "forms",
        "tasks": [
            "Fill in the change-of-address form with 12 Elm Street, Springfield, 01101, and submit it.",
            "Start a library card application for Alex Rivera, born 1990-04-12, and stop before submitting.",
            "Fill in the contact form asking for a callback about a billing error.",
            "Complete the volunteer sign-up form for Saturday mornings.",
            "Fill in the job application form using the CV in the uploads folder (cv.pdf).",
        ],
    },
    {
        "job": "travel",
        "title": "Book travel: flights, hotels, rides",
        "advertised_by": ["Meta Muse", "Instinct"],
        "profile": "airline",
        "tasks": [
            "Find the cheapest nonstop flight from Lisbon to Berlin next Friday and book it for one adult.",
            "Change my booking ABC123 to the evening flight on the same day.",
            "Add one checked bag to my upcoming trip.",
            "Choose a window seat on my next flight.",
            "Find my upcoming trips and report the departure time of the next one.",
            "Cancel booking XYZ789 and report the refund amount.",
        ],
    },
    {
        "job": "appointments",
        "title": "Book appointments (doctor, services)",
        "advertised_by": ["Grokbot"],
        "profile": "forms",
        "tasks": [
            "Book the earliest available general check-up appointment next week.",
            "Reschedule my dentist appointment to any morning the week after.",
            "Find which clinics have a dermatology slot this month and list them.",
            "Cancel my Thursday physiotherapy appointment.",
        ],
    },
    {
        "job": "returns",
        "title": "Return an order",
        "advertised_by": ["Grokbot"],
        "profile": "shop",
        "tasks": [
            "Start a return for the headphones in my most recent order, reason: not as described.",
            "Check the status of my open return and report when the refund is expected.",
            "Find which of my orders from the last 30 days can still be returned.",
            "Report the delivery date of my order containing a phone case.",
        ],
    },
    {
        "job": "research_then_buy",
        "title": "Research a purchase, then buy after approval",
        "advertised_by": ["Meta Muse"],
        "profile": "shop",
        "tasks": [
            "Find the three best-rated electric kettles under $50, compare them, then buy the best one.",
            "Compare the two cheapest 27-inch monitors with at least 4.5 stars and add the better one to the cart.",
            "Find a gift under $30 for a coffee lover, add it to the cart and check out.",
            "Reorder the coffee beans from my last order.",
        ],
    },
    {
        "job": "lower_a_bill",
        "title": "Lower a bill",
        "advertised_by": ["Meta Muse"],
        "profile": "bank",
        "tasks": [
            "Find every recurring subscription in my last three months of transactions and total them.",
            "Find the plan with the lowest monthly fee that keeps my current features and switch to it.",
            "Cancel the streaming subscription I have not used in two months.",
            "Dispute the duplicate charge from 'CloudBox' last week.",
        ],
    },
    {
        "job": "government_errands",
        "title": "Government errands (register a car, renew a licence)",
        "advertised_by": ["Grokbot"],
        "profile": "forms",
        "tasks": [
            "Renew the vehicle registration for plate 7ABC123 for one year.",
            "Find which documents a passport renewal needs and list them.",
            "Book an appointment at the licence office nearest to postcode 01101.",
            "Pay the parking fine with reference PF-55821.",
        ],
    },
    {
        "job": "summarise_docs",
        "title": "Summarise docs and take meeting notes",
        "advertised_by": ["Grokbot"],
        "profile": "calendar",
        "tasks": [
            "Open 'Q3 plan.docx' in Files and summarise it in five bullets.",
            "Create a document called 'Meeting notes 12 May' with the agenda from the calendar event.",
            "Find the latest version of the budget spreadsheet and report the total.",
            "Share 'Roadmap.pdf' with dev@offgrid-mail.test as view-only.",
        ],
    },
    {
        "job": "sort_saved_items",
        "title": "Sort your own saved items",
        "advertised_by": ["Meta Muse"],
        "profile": "shop",
        "tasks": [
            "Move every item in my wishlist under $20 to a new list called 'Small gifts'.",
            "Remove items from my saved-for-later list that are out of stock.",
            "Sort my saved recipes into folders by meal: breakfast, lunch, dinner.",
        ],
    },
    {
        "job": "work_reports",
        "title": "Work tasks: dashboards, forecasts, reports",
        "advertised_by": ["Claude Duet", "OpenAI Dots"],
        "profile": "calendar",
        "tasks": [
            "Open the sales spreadsheet and report the month with the highest revenue.",
            "Add a row for June with revenue 42,000 to the sales spreadsheet.",
            "Create a chart of monthly revenue in the sales spreadsheet.",
            "Write a one-page weekly status report from the notes in 'Week 19' and save it in Files.",
        ],
    },
]

# ---------------------------------------------------------------------------------------------
# Part 2: 25 common web jobs x 10 sites. Mind2Web-Live sites are dropped; a site in the shared
# holdout is labelled holdout (harness benches only). The fourth field is unused (kept for history).
# stage 1 = read-only public tasks; stage 2 = needs a sandbox sign-in (practised in part 1).
# ---------------------------------------------------------------------------------------------

CATEGORIES = [
    ("search_answer", "Search and get a quick answer", 1, "qwant.com",
     ["bing.com", "duckduckgo.com", "search.yahoo.com", "search.brave.com", "ecosia.org",
      "startpage.com", "yandex.com", "mojeek.com", "perplexity.ai", "qwant.com"],
     ["Search for '{q}' and report the first result's title.",
      "Find the answer to: {fact}",
      "Search for '{q}' and open the first result that is not an ad.",
      "Search for news about '{topic}' from the past week and report two headlines.",
      "Search for images of '{thing}' and report how many results the page says there are, if shown."]),
    ("email", "Read and reply to email", 2, "tuta.com",
     ["outlook.live.com", "mail.yahoo.com", "proton.me", "mail.zoho.com", "aol.com", "gmx.com",
      "mail.com", "fastmail.com", "mail.yandex.com", "tuta.com"],
     ["Find the page that explains how to set up an email forwarding rule and summarise the steps.",
      "Find the free plan's storage limit.",
      "Find how to create a folder or label, and list the steps."]),
    ("video", "Watch a video", 1, "dailymotion.com",
     ["youtube.com", "vimeo.com", "twitch.tv", "tiktok.com", "ted.com", "rumble.com",
      "bilibili.tv", "archive.org", "nebula.tv", "dailymotion.com"],
     ["Search for '{topic}' videos and report the title and length of the top result.",
      "Find the most viewed video about '{topic}' and report its view count.",
      "Open a video about '{thing}' and report the channel or uploader name.",
      "Find a playlist or collection about '{topic}' and report how many videos it has."]),
    ("social", "Check social feeds and post", 2, "mastodon.social",
     ["bsky.app", "tumblr.com", "pinterest.com", "threads.net", "x.com", "instagram.com",
      "facebook.com", "linkedin.com", "vk.com", "mastodon.social"],
     ["Find the public profile of '{org}' and report its follower count.",
      "Search for posts about '{topic}' and summarise the top one.",
      "Find the page that explains how to make an account private."]),
    ("messaging", "Send a message", 2, "chat.zulip.org",
     ["web.whatsapp.com", "messenger.com", "app.slack.com", "discord.com", "web.telegram.org",
      "teams.live.com", "app.element.io", "community.mattermost.com", "rocket.chat", "chat.zulip.org"],
     ["Find the help page on how to mute a conversation and list the steps.",
      "Find the maximum file size you can send.",
      "Find how to start a group chat, and list the steps."]),
    ("shop", "Shop and compare prices", 1, "wayfair.com",
     ["ebay.com", "walmart.com", "target.com", "bestbuy.com", "etsy.com", "aliexpress.com",
      "ikea.com", "newegg.com", "homedepot.com", "wayfair.com"],
     ["Search for '{product}' and report the cheapest result's price.",
      "Search for '{product}', filter to 4 stars and up, and report the top result.",
      "Compare the first two results for '{product}' and say which is cheaper.",
      "Find the return policy and report how many days you have to return an item.",
      "Search for '{product}', sort by price low to high, and report the first three prices.",
      "Open the first result for '{product}' and list three specifications."]),
    ("news", "Read the news", 1, "npr.org",
     ["cnn.com", "theguardian.com", "reuters.com", "apnews.com", "aljazeera.com", "nbcnews.com",
      "cbsnews.com", "news.yahoo.com", "thehindu.com", "npr.org"],
     ["Report the top headline in the {section} section.",
      "Search for coverage of '{topic}' and summarise the latest article in two sentences.",
      "Find the author and publish date of the lead story.",
      "Open the most-read list and report the first three titles."]),
    ("fact", "Look up a fact", 1, "ourworldindata.org",
     ["en.wikipedia.org", "britannica.com", "merriam-webster.com", "dictionary.com", "wikihow.com",
      "worldometers.info", "timeanddate.com", "cia.gov", "wikivoyage.org", "ourworldindata.org"],
     ["Find {fact}",
      "Look up '{thing}' and report the first sentence of its description.",
      "Find the population of {city} and the year of the figure.",
      "Look up the definition of '{word}'."]),
    ("weather", "Check the weather", 1, "yr.no",
     ["weather.com", "accuweather.com", "wunderground.com", "weather.gov", "metoffice.gov.uk",
      "windy.com", "meteoblue.com", "bom.gov.au", "weatherbug.com", "yr.no"],
     ["Report tomorrow's high and low temperature in {city}.",
      "Will it rain in {city} this weekend? Report the chance of rain for Saturday.",
      "Report the wind speed in {city} right now.",
      "Find the 10-day forecast for {city} and report the warmest day."]),
    ("maps", "Find a place or directions", 1, "viamichelin.com",
     ["openstreetmap.org", "bing.com/maps", "mapquest.com", "wego.here.com", "waze.com",
      "citymapper.com", "rome2rio.com", "mappy.com", "yandex.com/maps", "viamichelin.com"],
     ["Find driving directions from {city} to {city2} and report the distance.",
      "Find a pharmacy near {landmark} and report its address.",
      "Report how long it takes to travel from {city} to {city2} by train or transit, if shown.",
      "Search for '{landmark}' and report its address."]),
    ("track_return", "Track an order or return it", 1, "auspost.com.au",
     ["ups.com", "fedex.com", "usps.com", "dhl.com", "17track.net", "parcelsapp.com",
      "aftership.com", "royalmail.com", "canadapost-postescanada.ca", "auspost.com.au"],
     ["Find the page where you track a parcel and report what number it asks for.",
      "Find how to schedule a pickup and list the steps.",
      "Find the price to send a 1 kg parcel domestically, if the site shows it.",
      "Find the customer service hours."]),
    ("flights", "Book a flight", 1, "momondo.com",
     ["skyscanner.com", "kayak.com", "expedia.com", "kiwi.com", "priceline.com", "trip.com",
      "orbitz.com", "cheapoair.com", "delta.com", "momondo.com"],
     ["Search one-way flights from {city} to {city2} on {date} and report the cheapest price.",
      "Search round-trip flights from {city} to {city2}, leaving {date} for one week; report the shortest nonstop.",
      "Filter flights from {city} to {city2} on {date} to nonstop only and report how many remain.",
      "Find the baggage fee page and report the first checked bag price."]),
    ("stays", "Book a hotel or stay", 1, "hostelworld.com",
     ["airbnb.com", "hotels.com", "agoda.com", "trivago.com", "vrbo.com", "marriott.com",
      "hilton.com", "ihg.com", "choicehotels.com", "hostelworld.com"],
     ["Find stays in {city} for two adults, {date} for three nights, and report the cheapest.",
      "Find a stay in {city} rated 9+ or 4.5+ and report its price per night.",
      "Filter stays in {city} to ones with free cancellation and report the first result.",
      "Find the cancellation policy page."]),
    ("food", "Order food", 1, "grubhub.com",
     ["ubereats.com", "doordash.com", "deliveroo.co.uk", "swiggy.com", "zomato.com",
      "just-eat.co.uk", "seamless.com", "instacart.com", "dominos.com", "grubhub.com"],
     ["Find a {cuisine} restaurant that delivers to {city} and report its delivery fee.",
      "Open a menu and report the price of the first {dish}.",
      "Find the help page for a missing item in an order."]),
    ("bank", "Pay a bill or check a balance", 2, "citi.com",
     ["paypal.com", "chase.com", "bankofamerica.com", "wellsfargo.com", "capitalone.com",
      "wise.com", "revolut.com", "venmo.com", "hdfcbank.com", "citi.com"],
     ["Find the fee for an international transfer and report it.",
      "Find the nearest branch or ATM to {city}, if the site has a locator.",
      "Find the current savings account interest rate.",
      "Find how to report a lost card and list the steps."]),
    ("jobs", "Find and apply for a job", 1, "dice.com",
     ["indeed.com", "linkedin.com/jobs", "glassdoor.com", "monster.com", "ziprecruiter.com",
      "simplyhired.com", "careerbuilder.com", "wellfound.com", "naukri.com", "dice.com"],
     ["Search for '{role}' jobs in {city} and report the first three titles and companies.",
      "Search for remote '{role}' jobs posted in the last week and report how many there are.",
      "Open the first '{role}' listing and report the salary, if shown."]),
    ("docs", "Edit or share a doc or file", 2, "coda.io",
     ["onedrive.live.com", "dropbox.com", "box.com", "notion.so", "writer.zoho.com", "cryptpad.fr",
      "pad.riseup.net", "docs.proton.me", "quip.com", "coda.io"],
     ["Find the free plan's storage limit.",
      "Find how to share a file with view-only access and list the steps.",
      "Find the list of supported file types for preview."]),
    ("calendar", "Manage a calendar and meetings", 2, "teamup.com",
     ["outlook.live.com/calendar", "calendar.yahoo.com", "calendly.com", "cal.com",
      "calendar.zoho.com", "calendar.proton.me", "timetreeapp.com", "doodle.com", "when2meet.com",
      "teamup.com"],
     ["Find how to share a calendar with someone and list the steps.",
      "Find the price of the cheapest paid plan.",
      "Find how to set working hours."]),
    ("reviews", "Read reviews before buying", 1, "rtings.com",
     ["yelp.com", "tripadvisor.com", "trustpilot.com", "consumerreports.org", "cnet.com",
      "pcmag.com", "goodreads.com", "rottentomatoes.com", "tomsguide.com", "rtings.com"],
     ["Find reviews of '{thing}' and report the average rating.",
      "Find the best-rated {place} in {city} and report its rating and review count.",
      "Find a review of '{product}' and summarise its verdict in one sentence."]),
    ("community", "Ask a community a question", 1, "lemmy.world",
     ["reddit.com", "quora.com", "stackoverflow.com", "superuser.com", "askubuntu.com",
      "math.stackexchange.com", "answers.microsoft.com", "meta.discourse.org",
      "news.ycombinator.com", "lemmy.world"],
     ["Search for '{question}' and report the top answer's first sentence.",
      "Find the most upvoted post this week about '{topic}' and report its title.",
      "Find the community rules page and list the first three rules."]),
    ("music", "Listen to music or podcasts", 1, "last.fm",
     ["open.spotify.com", "music.youtube.com", "soundcloud.com", "bandcamp.com", "deezer.com",
      "tidal.com", "pandora.com", "pocketcasts.com", "podbean.com", "last.fm"],
     ["Search for the artist '{artist}' and report their most popular track.",
      "Find a podcast about '{topic}' and report the latest episode title.",
      "Find the album '{album}' and report how many tracks it has."]),
    ("learn", "Learn with a course or tutorial", 1, "futurelearn.com",
     ["khanacademy.org", "edx.org", "udemy.com", "codecademy.com", "freecodecamp.org",
      "w3schools.com", "ocw.mit.edu", "duolingo.com", "skillshare.com", "futurelearn.com"],
     ["Find a beginner course on '{subject}' and report its length.",
      "Search for '{subject}' and report the first three course titles.",
      "Find a free course on '{subject}' and report who teaches it."]),
    ("gov_forms", "Fill in a form (government, sign-ups)", 1, "canada.ca",
     ["usa.gov", "gov.uk", "irs.gov", "ssa.gov", "dmv.ca.gov", "india.gov.in", "travel.state.gov",
      "uscis.gov", "my.gov.au", "canada.ca"],
     ["Find the form to {errand} and report its name or number.",
      "Find the fee to {errand}.",
      "Find the page on how to {errand} and list the documents it asks for.",
      "Find the contact form, fill in name 'Alex Rivera' and a one-line question, and stop before submitting."]),
    ("recipes", "Find a recipe", 1, "budgetbytes.com",
     ["bbcgoodfood.com", "foodnetwork.com", "seriouseats.com", "epicurious.com",
      "simplyrecipes.com", "tasty.co", "delish.com", "bonappetit.com", "food.com", "budgetbytes.com"],
     ["Find a recipe for {dish} and report the total time.",
      "Find a vegetarian {dish} recipe with at least 4 stars and list its ingredients.",
      "Find a {dish} recipe that serves 4 or more and report the first step."]),
    ("scores_stocks", "Check sports scores or stocks", 1, "livescore.com",
     ["finance.yahoo.com", "marketwatch.com", "investing.com", "cnbc.com", "nasdaq.com",
      "bloomberg.com", "cbssports.com", "nba.com", "skysports.com", "livescore.com"],
     ["Report the current price of {ticker}.",
      "Report the result of the most recent {sport} match shown on the home page.",
      "Find {ticker}'s 52-week high.",
      "Report the top story in the {sport} section."]),
]

# Slot values. Each site picks a different rotation, so no two sites get identical goals.
SLOTS = {
    "q": ["best budget laptop 2026", "how to descale a kettle", "tallest building in Europe",
          "solar panel efficiency record", "easy sourdough starter"],
    "fact": ["how tall Mount Kilimanjaro is.", "the boiling point of water at 3000 m altitude.",
             "who designed the Eiffel Tower.", "the year the Berlin Wall fell.",
             "how many moons Saturn has."],
    "topic": ["electric bikes", "home composting", "remote work", "space telescopes", "chess openings"],
    "thing": ["the northern lights", "red pandas", "the Great Barrier Reef", "Japanese gardens",
              "vintage typewriters"],
    "org": ["NASA", "the World Health Organization", "UNICEF", "the Mozilla Foundation", "Wikipedia"],
    "product": ["wireless earbuds", "office chair", "4K monitor", "air fryer", "standing desk",
                "running shoes", "mechanical keyboard"],
    "section": ["world", "business", "technology", "science", "health"],
    "city": ["Lisbon", "Toronto", "Melbourne", "Osaka", "Denver", "Edinburgh", "Cape Town"],
    "city2": ["Porto", "Montreal", "Sydney", "Kyoto", "Boulder", "Glasgow", "Stellenbosch"],
    "landmark": ["the Louvre", "Times Square", "Sydney Opera House", "Shibuya Crossing", "Big Ben"],
    "date": ["the 14th of next month", "the first Friday of next month", "the 21st of next month"],
    "cuisine": ["Thai", "Mexican", "Indian", "Italian", "Lebanese"],
    "dish": ["lasagne", "pad thai", "chickpea curry", "banana bread", "shakshuka"],
    "role": ["data analyst", "frontend developer", "product designer", "nurse", "accountant"],
    "place": ["coffee shop", "bakery", "bookstore", "ramen restaurant", "museum"],
    "question": ["how to fix a slow laptop", "what is a good first programming language",
                 "how to keep basil alive", "why does my wifi drop at night"],
    "artist": ["Nils Frahm", "Khruangbin", "Norah Jones", "Daft Punk", "Hiromi"],
    "album": ["Kind of Blue", "Random Access Memories", "OK Computer", "Blue Train", "Discovery"],
    "subject": ["statistics", "Python", "Spanish", "photography", "personal finance"],
    "errand": ["renew a passport", "change your address", "replace a lost ID card",
               "register to vote", "apply for a fishing licence"],
    "ticker": ["AAPL", "MSFT", "NVDA", "TSLA", "SAP"],
    "sport": ["football", "basketball", "cricket", "tennis", "baseball"],
    "word": ["ephemeral", "serendipity", "laconic", "ubiquitous", "quixotic"],
}

TASKS_PER_SITE = 10


def domain_of(site: str) -> str:
    host = urlparse(site if "://" in site else f"https://{site}").hostname or site
    return host.lower().removeprefix("www.")


def registrable(host: str) -> str:
    """Good enough for the exclusion check: the last two labels, three for known 2-level TLDs."""
    parts = host.split(".")
    if len(parts) >= 3 and parts[-2] in {"co", "com", "gov", "org", "net"} and len(parts[-1]) == 2:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:])


def webvoyager_hit(site: str) -> str | None:
    host = domain_of(site)
    for excluded in WEBVOYAGER:
        if host == excluded or host.endswith(f".{excluded}") or registrable(host) == excluded:
            return excluded
    return None


def fill(template: str, rotation: int) -> str:
    out = template
    for name, values in SLOTS.items():
        token = "{" + name + "}"
        if token in out:
            out = out.replace(token, values[rotation % len(values)])
    return out


def build() -> dict:
    tasks: list[dict] = []
    for job in PAID_JOBS:
        for index, goal in enumerate(job["tasks"], start=1):
            tasks.append({
                "id": f"paid-{job['job']}-{index:02d}",
                "goal": goal,
                "profile": job["profile"],
                "category": job["job"],
                "part": "paid_agent_jobs",
                "stage": 2,
                "split": "train",
                "read_only": False,
            })
    sites_out = []
    for key, title, stage, holdout, sites, templates in CATEGORIES:
        for site_index, site in enumerate(sites):
            if domain_of(site) in MIND2WEB_LIVE:
                continue
            split = "holdout" if domain_of(site) in SHARED_HOLDOUT else "train"
            sites_out.append({"category": key, "site": site, "split": split, "stage": stage})
            url = f"https://{site}" if "/" not in site else f"https://{site}"
            for n in range(TASKS_PER_SITE):
                template = templates[n % len(templates)]
                rotation = site_index * 3 + n
                goal = f"On {domain_of(site)}: {fill(template, rotation)}"
                tasks.append({
                    "id": f"web-{key}-{domain_of(site).replace('/', '-')}-{n + 1:02d}",
                    "goal": goal,
                    "url": url,
                    "category": key,
                    "part": "common_web_jobs",
                    "stage": stage,
                    "split": split,
                    "read_only": True,
                })
    return {
        "version": 1,
        "about": (
            "LFM3 web-agent training tasks. Part 1 (paid_agent_jobs) runs on sandbox test "
            "accounts (OGAD sandbox-profiles.ts; bench field `profile`). Part 2 (common_web_jobs) "
            "is read-only on public sites. split=holdout marks sites in the holdout shared with "
            "the LFM3 new-site set: harness benches only, never LFM3 training. WebVoyager and "
            "Mind2Web-Live test sites are excluded everywhere."
        ),
        "webvoyager_excluded": sorted(set(WEBVOYAGER.values())),
        "mind2web_live_excluded": sorted(MIND2WEB_LIVE),
        "shared_holdout": sorted(SHARED_HOLDOUT),
        "categories": [
            {"key": key, "title": title, "stage": stage,
             "sites": [x for x in sites if domain_of(x) not in MIND2WEB_LIVE]}
            for key, title, stage, _, sites, _ in CATEGORIES
        ],
        "paid_agent_jobs": [
            {k: job[k] for k in ("job", "title", "advertised_by", "profile")} for job in PAID_JOBS
        ],
        "sites": sites_out,
        "tasks": tasks,
    }


def check(data: dict) -> list[str]:
    problems: list[str] = []
    if len(PAID_JOBS) != 12:
        problems.append(f"expected 12 paid-agent jobs, found {len(PAID_JOBS)}")
    if len(CATEGORIES) != 25:
        problems.append(f"expected 25 categories, found {len(CATEGORIES)}")
    holdout_domains = SHARED_HOLDOUT
    seen_ids: set[str] = set()
    for key, _, _, holdout, sites, _ in CATEGORIES:
        if len(sites) != 10:
            problems.append(f"{key}: {len(sites)} sites, expected 10")
        if len(set(map(domain_of, sites))) != len(sites):
            problems.append(f"{key}: duplicate site")
        for site in sites:
            if domain_of(site) in MIND2WEB_LIVE and any(
                    t.get("url", "").endswith(site) for t in data["tasks"]):
                problems.append(f"{key}: {site} is a Mind2Web-Live site")
            hit = webvoyager_hit(site)
            if hit:
                problems.append(f"{key}: {site} is a WebVoyager site ({hit})")
    for task in data["tasks"]:
        if task["id"] in seen_ids:
            problems.append(f"duplicate task id {task['id']}")
        seen_ids.add(task["id"])
        if "{" in task["goal"]:
            problems.append(f"{task['id']}: unfilled slot in goal")
        if task["split"] == "train" and task.get("url"):
            host = domain_of(task["url"])
            if host in holdout_domains:
                problems.append(f"{task['id']}: trains on held-out site {host}")
    return problems


def main() -> int:
    data = build()
    problems = check(data)
    if problems:
        print("\n".join(problems), file=sys.stderr)
        return 1
    train = sum(1 for t in data["tasks"] if t["split"] == "train")
    holdout = sum(1 for t in data["tasks"] if t["split"] == "holdout")
    print(f"{len(data['tasks'])} tasks: {train} train, {holdout} holdout; "
          f"{len(data['sites'])} sites; {len(PAID_JOBS)} paid-agent jobs")
    if "--check" in sys.argv:
        return 0
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "training-tasks.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    # The bench reads a plain list: one file per split, so the holdout is never run as training.
    for split in ("train", "holdout"):
        rows = [
            {k: t[k] for k in ("id", "goal", "url", "profile") if k in t}
            for t in data["tasks"]
            if t["split"] == split
        ]
        (OUT / f"bench-{split}.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
