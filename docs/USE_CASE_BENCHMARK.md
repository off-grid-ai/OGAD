# OGAD Web Use Benchmark (v0 draft)

The main score for the planner / actor / evaluator models: **tasks completed end to end**, run
through OGAD's harness on live sites. Also measured: actions per task and seconds per action.

Sources: top use cases of Muse, Instinct, OpenAI Dots and Grok Bot; OGAD's 7 sample tasks; the
user's own Codex browser use (136 sessions). Tasks are grouped by the pattern they test.

Rules for every task:

- Never pay, send, post, publish, delete or submit a binding form. Those steps must end in
  `takeover` — reaching them correctly counts as success.
- "Login" = needs a signed-in session (the user's Brave profile or a test account).
- Success checks: **url** (URL contains), **text** (text on screen), **answer** (the evaluator's
  `success(...)` answer matches), **state** (a field, cart, draft or record exists),
  **takeover** (stops at the right step with the right reason).

## 1. Research: search, filter, collect

| # | Site | Goal | Check | Login |
|---|---|---|---|---|
| R1 | x.com | Find the most-liked post about "local LLMs" from the past week and say who posted it | answer | yes |
| R2 | x.com | List 3 recent posts that mention "Off Grid AI" with their authors | answer | yes |
| R3 | linkedin.com | Find 3 posts from this week about "AI agents in banking" and give the authors | answer | yes |
| R4 | reddit.com | Find the top post this month in r/LocalLLaMA about Apple Silicon and give its title | answer | no |
| R5 | youtube.com | Find the most-viewed video from the last month about "Mac mini AI cluster" | answer | no |
| R6 | news.google.com | Find today's top 3 headlines about UPI | answer | no |
| R7 | huggingface.co | Find the most-downloaded GGUF model released this month under 4B parameters | answer | no |
| R8 | github.com | Find the newest release of llama.cpp and its version tag | answer | no |
| R9 | producthunt.com | Name today's top 3 launches in AI | answer | no |
| R10 | instagram.com | Find the latest post from a given account and say what it shows | answer | yes |

## 2. Shopping and price compare

| # | Site | Goal | Check | Login |
|---|---|---|---|---|
| S1 | amazon.in | Find the price of a named product and its delivery date to a PIN code | answer | no |
| S2 | amazon.in + flipkart.com | Compare the price of the same product on both sites and say which is cheaper | answer | no |
| S3 | flipkart.com | Find the cheapest 4-star+ wireless earbuds under ₹2,000 | answer | no |
| S4 | myntra.com | Add a named T-shirt in size M to the bag | state | yes |
| S5 | kings-shop-ten.vercel.app | Add a named gift box to the cart and go to checkout | takeover | no |
| S6 | croma.com | Check if a named laptop is in stock in a city | answer | no |
| S7 | blinkit.com / bigbasket.com | Add 5 grocery items from a list to the cart | state | yes |
| S8 | amazon.in | Find the seller and return policy of a named product | answer | no |

## 3. Travel and booking

| # | Site | Goal | Check | Login |
|---|---|---|---|---|
| T1 | google.com/travel/flights | Cheapest non-stop flight Pune → Delhi on a given date: airline and price | answer | no |
| T2 | makemytrip.com | Same as T1, then select the flight and stop at payment | takeover | no |
| T3 | booking.com | Hotels in Goa for 2 nights, 2 guests, rating 8+: the cheapest one | answer | no |
| T4 | irctc.co.in | Trains Mumbai → Pune tomorrow with 2A seats available | answer | no |
| T5 | zomato.com / opentable | Book a table for 4 on Friday 8 pm at a named restaurant | takeover | yes |
| T6 | airline site | Open the flight-delay compensation form and fill booking details | takeover | no |
| T7 | google.com/maps | Best-rated cafe open now near a given area, with its rating | answer | no |

## 4. Mail and messages

| # | Site | Goal | Check | Login |
|---|---|---|---|---|
| M1 | mail.google.com | Archive every email from a named newsletter | state | yes |
| M2 | mail.google.com | Unsubscribe from a named newsletter | state | yes |
| M3 | mail.google.com | Draft a reply to the latest mail from a person, don't send | state | yes |
| M4 | mail.google.com | Find unpaid invoices mentioned in the last 30 days and list them | answer | yes |
| M5 | slack.com (web) | Summarise the last 10 messages in a channel | answer | yes |

## 5. SaaS admin and dashboards

| # | Site | Goal | Check | Login |
|---|---|---|---|---|
| A1 | RevenueCat | Create a new lifetime product with a given price | state | yes |
| A2 | Stripe (test mode) | Create a coupon: code, % off, duration | state | yes |
| A3 | Stripe (test mode) | Change the price of a named product, confirm the dialog | state | yes |
| A4 | PostHog | Read the number of sign-ups yesterday | answer | yes |
| A5 | SonarCloud | List the failing quality-gate conditions for a project | answer | yes |
| A6 | GitHub | Mark all files in a named PR as viewed | state | yes |
| A7 | AWS console | Start a named EC2 instance; on a capacity error, retry | state | yes |
| A8 | RunPod | Read GPU type, volume size and status of a pod | answer | yes |
| A9 | HubSpot (free) | Move a named deal to the next stage | state | yes |
| A10 | Shopify admin | List products with stock under 5 | answer | yes |
| A11 | Meta Ads Manager | Read spend and ROAS of the top 3 campaigns this week | answer | yes |
| A12 | Domain registrar | List domains that expire in the next 60 days | answer | yes |

## 6. Accounts, bills and subscriptions

| # | Site | Goal | Check | Login |
|---|---|---|---|---|
| B1 | Google Play / App Store subs | List active subscriptions with renewal dates | answer | yes |
| B2 | A streaming service | Start cancelling a subscription and stop at the final confirm | takeover | yes |
| B3 | Airtel / Jio | Recharge a mobile number with a named plan, stop at payment | takeover | no |
| B4 | Amazon orders | Track the latest order: status and ETA | answer | yes |
| B5 | Amazon orders | Start a return for a named item, stop at the final confirm | takeover | yes |

## 7. Forms and government

| # | Site | Goal | Check | Login |
|---|---|---|---|---|
| F1 | Google Forms | Fill a given test form with given answers and stop before submit | takeover | no |
| F2 | F6S / accelerator | Fill an application's first page from a brief, save draft | state | yes |
| F3 | passportindia.gov.in | Check application status page fields; stop at CAPTCHA | takeover | no |
| F4 | unclaimed-property search (state site) | Search a name and report matches | answer | no |
| F5 | Luma | Create an event draft with title, date and location | state | yes |

## 8. Feeds and social actions

| # | Site | Goal | Check | Login |
|---|---|---|---|---|
| X1 | instagram.com | Train My Feed: like 3 posts about a topic, nothing else | state | yes |
| X2 | x.com | Follow a named account | state | yes |
| X3 | x.com | Hide low-quality replies under a given post (max 3) | state | yes |
| X4 | linkedin.com | Accept the newest connection request from a named person | state | yes |

## 9. QA of the user's own products

| # | Site | Goal | Check | Login |
|---|---|---|---|---|
| Q1 | getoffgridai.co | Check the pricing section shows 3 plans with prices; report them | answer | no |
| Q2 | getoffgridai.co (mobile width) | Open the mobile menu and check every link opens a page | answer | no |
| Q3 | pagespeed.web.dev | Run a report for getoffgridai.co and give the mobile score | answer | no |
| Q4 | wednesday.is | Find the contact page and say what fields the form has | answer | no |

## 10. Documents, spreadsheets and files

Google Docs and Sheets draw most content on a canvas, so the accessibility tree misses text and
cells. The actor must use keyboard routes (Name box, Ctrl+F, menus, shortcuts) and the image
(coordinate clicks). Office on the web has a fuller tree.

| # | Site | Goal | Check | Login |
|---|---|---|---|---|
| D1 | docs.google.com/spreadsheets | Put a given value in cell B4 of a named sheet | state | yes |
| D2 | Google Sheets | Add a row with 4 given values at the end of a table | state | yes |
| D3 | Google Sheets | Sum column C and write the total under it with a formula | state | yes |
| D4 | Google Sheets | Sort a table by the "Date" column, newest first | state | yes |
| D5 | Google Sheets | Read the value in the row for a named item and report it | answer | yes |
| D6 | docs.google.com/document | Replace every "Q3" with "Q4" in a named doc | state | yes |
| D7 | Google Docs | Add a heading "Next steps" and 3 bullet points at the end | state | yes |
| D8 | Google Docs | Add a comment on a given sentence | state | yes |
| D9 | drive.google.com | Find a file by name and move it into a named folder | state | yes |
| D10 | Google Drive | Share a named file as "view only" with an email (stop at Send) | takeover | yes |
| D11 | Google Drive | Create a folder and upload a given file into it | state | yes |
| D12 | office.com (Word on the web) | Change a doc's title text and make it bold | state | yes |
| D13 | office.com (Excel on the web) | Add a column "Total" = Price × Qty for every row | state | yes |
| D14 | Google Slides | Change the title on slide 2 to a given text | state | yes |

Desktop versions (Word, Excel, Numbers, Pages, Finder file moves) go in the computer-use
benchmark.

## 11. Knowledge-worker admin (top 20)

| # | Task | Apps | Check | Login |
|---|---|---|---|---|
| K1 | Archive and label every mail from a sender; flag the urgent one | Gmail / Outlook | state | yes |
| K2 | Forward a named mail with its attachment to a person (stop at Send) | Gmail / Outlook | takeover | yes |
| K3 | Find a free 30-min slot with 2 people this week and draft the invite | Google Calendar | takeover | yes |
| K4 | Decline a named meeting and propose a new time | Google Calendar | takeover | yes |
| K5 | Find a file and share it view-only with a person (stop at Send) | Google Drive / OneDrive | takeover | yes |
| K6 | Rename a file and move it into a new folder | Google Drive | state | yes |
| K7 | Add a row to a tracker sheet and update a formula | Google Sheets / Excel | state | yes |
| K8 | Add a comment on a paragraph in a doc | Google Docs / Word | state | yes |
| K9 | Fill an expense with a receipt upload (stop at Submit) | Zoho Expense / Expensify | takeover | yes |
| K10 | Apply for 1 day of leave next Friday (stop at Submit) | Keka / Darwinbox | takeover | yes |
| K11 | Open the approval queue and report the pending items | HR / finance portal | answer | yes |
| K12 | Move a named deal to the next stage and add a note | HubSpot / Zoho CRM | state | yes |
| K13 | Move a ticket to "In review" and assign it | Jira / Linear / Trello | state | yes |
| K14 | Fill an internal survey with given answers (stop at Submit) | Google Forms / MS Forms | takeover | yes |
| K15 | Find a policy-compliant flight for a trip (stop at payment) | travel portal | takeover | yes |
| K16 | Raise an IT ticket with category and screenshot (stop at Submit) | Freshdesk / ServiceNow | takeover | yes |
| K17 | Export last month's report filtered by a team and read the total | dashboard | answer | yes |
| K18 | Find the latest message about a topic in a Slack channel | Slack / Teams | answer | yes |
| K19 | Open today's next meeting and the doc linked in it | Calendar + Docs | state | yes |
| K20 | List unpaid vendor invoices older than 30 days | Zoho Books / Tally | answer | yes |

## Not in this benchmark (other tools)

Phone calls and hold-music, negotiation by chat, agent-to-agent messaging, podcasts, meal
tracking from photos, code fixes, writing decks and proposals.

## Computer use (next benchmark)

OGAD's samples (Spotify play, edit a screenshot, draft an email in Mail), the user's QA of
Off Grid Desktop, Windows VMs over Remote Desktop, and iPhone / Android mirrors.
