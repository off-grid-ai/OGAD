# Agent browser: sandbox test accounts and training tasks

For the LFM3 pipeline owner. The built-in browser is the web agent's local sandbox. Signed-in jobs
run on test accounts only, never on a person's real accounts or data.

## What the browser gives the harness

- **Sandbox profiles** (`src/main/browser/sandbox-profiles.ts`). Each profile is its own site and
  its own cookie jar:

  | id         | start page                                   | stands in for          |
  | ---------- | -------------------------------------------- | ---------------------- |
  | `mail`     | `https://offgrid-mail.test/`                 | Gmail / Outlook        |
  | `calendar` | `https://offgrid-cloud.test/apps/calendar/`  | Google Calendar, Docs  |
  | `shop`     | `https://offgrid-shop.test/`                 | an online shop         |
  | `airline`  | `https://offgrid-air.test/`                  | an airline             |
  | `bank`     | `https://offgrid-bank.test/`                 | a bank / billing site  |
  | `forms`    | `https://offgrid-forms.test/`                | government and booking forms |

  - Partition `persist:sandbox-<id>`; a sandbox page can only open its own hosts over https.
  - Only that profile's `.test` hosts trust the local CA. Every other site keeps Chromium's checks.
  - Override the list with `OFFGRID_SANDBOX_PROFILES` (JSON array of `{id,label,category,hosts,startUrl}`).
- **Bench field `profile`.** A Web Use bench task `{id, goal, url?, profile?}` runs in that profile.
  With no `url`, the profile's start page is used. An unknown profile fails the task.
- **Logins come from the Vault.** The harness fills the page; the model never sees the password.
  Passwords are also masked in every snapshot and tool result (`browser-secret-scrub.ts`).
- **Send / pay / delete.** On real sites the harness stops and asks the person first. Inside a
  sandbox profile it goes ahead, so training runs unattended.
- **Visits.** Each bench record has `visits` (the task's page trail). When a page was opened 3+
  times, the prompt gets one line saying so. On by default (Mac, 22 Nov);
  `OFFGRID_AGENT_VISIT_HINT=0` turns it off for the with/without A/B.
- **Emailed sign-in codes.** When a page asks for a one-time code, the harness reads fresh mail
  from that site (same registrable domain, received after the page opened, minus 30 s) in the
  person's connected mailboxes: IMAP accounts (core) and Gmail / Outlook (Pro). It waits up to
  150 s (`OFFGRID_EMAILED_CODE_WAIT_MS`) and fills the code like a Vault password. The model never
  sees it: the field reaches the model as `textbox "Verification code" … : ••••••••`, so the next
  step is to click Verify. No code, or two different codes, and the field stays empty: ask the
  person, as before. Detection and extraction: `src/main/browser/one-time-code.ts`.
- **Uploads.** `upload` actions read files from `<userData>/agent-uploads/` only (put `cv.pdf` there).
- **New actions now work:** `forward`, `reload`, `new_tab`, `switch_tab`, `close_tab`, `upload`.

## Set up the sandbox sites (workstation)

Run open-source apps behind one local-CA https proxy. Suggested apps:

| profile    | app (licence)                                      |
| ---------- | -------------------------------------------------- |
| `mail`     | Roundcube on Stalwart or docker-mailserver (GPL/AGPL) |
| `calendar` | Nextcloud with Calendar, Files, Office (AGPL)      |
| `shop`     | Saleor or Medusa demo store (BSD / MIT)            |
| `airline`  | a small booking app seeded with fake flights       |
| `bank`     | a fake-bank demo app with seeded transactions      |
| `forms`    | Formbricks or LimeSurvey (AGPL / GPL) plus a booking page |

Caddy with `tls internal` serves all of them on their `.test` names:

```
offgrid-mail.test   { tls internal; reverse_proxy 127.0.0.1:8081 }
offgrid-cloud.test  { tls internal; reverse_proxy 127.0.0.1:8082 }
offgrid-shop.test   { tls internal; reverse_proxy 127.0.0.1:8083 }
offgrid-air.test    { tls internal; reverse_proxy 127.0.0.1:8084 }
offgrid-bank.test   { tls internal; reverse_proxy 127.0.0.1:8085 }
offgrid-forms.test  { tls internal; reverse_proxy 127.0.0.1:8086 }
```

Point the names at the proxy on the machine that runs OGAD (`/etc/hosts`):

```
127.0.0.1 offgrid-mail.test offgrid-cloud.test offgrid-shop.test offgrid-air.test offgrid-bank.test offgrid-forms.test
```

Seed each app with fake people, mail, events, orders and transactions that match the goals in
`training-tasks.json` (names such as Priya Shah, Northwind Supplies, booking ABC123).

## Save the test logins

1. Create one test user per app. Use generated passwords; never a real account.
2. In OGAD, unlock the Vault and add one login per site, with the site set to its `https://…test`
   address. One login per site: the harness fills only when exactly one login matches.
3. Open **Test accounts** in the browser's library panel (dev builds) and sign in once by hand to
   check the fill.

## The task list

`python3 scripts/agent-browser/build-training-tasks.py` writes:

- `training-tasks.json`: everything, with labels: `part`, `category`, `stage`, `split`, `read_only`.
- `bench-train.json` and `bench-holdout.json`: plain bench lists (`{id, goal, url?, profile?}`).

What is in it:

- **Part 1, the 12 paid-agent jobs** (email, calendar, forms, travel, appointments, returns,
  research-then-buy, lower a bill, government errands, summarise docs, sort saved items, work
  reports): 57 tasks on the sandbox profiles. Stage 2.
- **Part 2, 25 common web jobs x 10 sites x 10 tasks**: read-only tasks on public sites. Stage 1
  for read-only categories; categories that need a sign-in to do the real job (email, social,
  messaging, bank, docs, calendar) stay on public help and pricing pages and are stage 2.
- **Holdout:** the one holdout shared with the LFM3 new-site set (`tasks-newsites-*`): 25 sites,
  one per category. Tasks on them are labelled `holdout`: harness benches only, never LFM3 training.
- **Excluded everywhere:** WebVoyager's 15 sites and the Mind2Web-Live test sites we had listed.
  `--check` fails the build if one slips in.

Suggested order: stage 1 first, then part 1 on the sandboxes, then the stage-2 public tasks.

## The workstation sandbox (running)

Set up on the Linux workstation on 22 Nov. The files are in `scripts/agent-browser/sandbox/`, and a
working copy runs from `~/agent-sandbox/`. Everything binds to `127.0.0.1` and nothing is reachable
from outside the box. Containers use CPUs 0-7 only and have small CPU and memory limits, so LFM3
training keeps its headroom.

| profile    | host                  | app                                             | direct port      | test user                |
| ---------- | --------------------- | ----------------------------------------------- | ---------------- | ------------------------ |
| `mail`     | `offgrid-mail.test`   | Roundcube 1.6 on docker-mailserver 15           | `127.0.0.1:8081` | `alex@offgrid-mail.test` |
| `calendar` | `offgrid-cloud.test`  | Nextcloud 31 + Calendar 5.5 (SQLite)            | `127.0.0.1:8082` | `alex`                   |
| `shop`     | `offgrid-shop.test`   | Larder & Co. (seeded Flask app)                 | `127.0.0.1:8083` | `alex`                   |
| `airline`  | `offgrid-air.test`    | Atlantic Air (seeded Flask app)                 | `127.0.0.1:8084` | `alex`                   |
| `bank`     | `offgrid-bank.test`   | Harbour Bank (seeded Flask app)                 | `127.0.0.1:8085` | `alex`                   |
| `forms`    | `offgrid-forms.test`  | Springfield Services: forms + clinic bookings   | `127.0.0.1:8086` | `alex`                   |

- **Proxy.** Caddy 2.10 (`tls internal`) on `127.0.0.1:443`. OGAD's sandbox partitions accept
  certificates for their own `.test` hosts only, so nothing needs to trust Caddy's CA.
- **Names.** `/etc/hosts` has one line: `127.0.0.1` plus the six names.
- **Mail stays inside.** Postfix sends only to `@offgrid-mail.test`. Mail to any other domain
  bounces. The people in the seed data (`priya.shah@`, `accounts@`, `dev@`, `sam@`, `lena@`,
  `marco@`, `jordan@`) all have mailboxes, so replies and forwards are delivered.
- **Shop, airline, bank and forms.** Each is one small Flask app (`mini/app.py`, one image,
  `SITE=…`). We chose these over Saleor, Medusa and Formbricks because the paid-agent goals need
  returns, wishlists, saved-for-later, recipes, same-day flight changes, seats, bags, refunds,
  subscriptions with "last used", plan switching, disputes, fines, plates and clinic slots. Those
  demos do not have these features. Data lives in memory and is seeded relative to today, so a
  restart gives a clean state.
- **Seed data** (`seed/seed.py` for mail and Nextcloud) matches `training-tasks.json`: Priya Shah's
  Thursday 3pm ask, the Northwind Supplies invoice NW-2291, the Q3 offsite thread, newsletters
  older and newer than 7 days, tracking number PW-7731-4402-9918, Standup tomorrow, Lunch with
  Sam on Wednesday, Sprint planning, the busy and free parts of Friday afternoon, `Q3 plan.docx`,
  `Budget v1/v2/v3 final.xlsx`, `Sales 2026.xlsx`, `Roadmap.pdf` and `Week 19/notes.md`. The
  seeded apps hold bookings ABC123 and XYZ789, the duplicate CloudBox charge, a streaming
  subscription last used about 70 days ago, parking fine PF-55821 and plate 7ABC123.
- **Passwords** are generated once into `~/agent-sandbox/.env` (mode 600) and never printed.
  The OGAD Vault (dev profile `~/agent-sandbox/ogad/profile`) holds one login per
  `https://…test` site. Its master password is `VAULT_PASSWORD` in the same file.

Commands (on the workstation):

```
~/agent-sandbox/sandbox.sh up       # build, start, create users, seed
~/agent-sandbox/sandbox.sh status   # containers + an https check of the six hosts
~/agent-sandbox/sandbox.sh reset    # clean shop/airline/bank/forms, re-seed mail + cloud (do this before a run)
~/agent-sandbox/sandbox.sh down     # stop (data kept in docker volumes)
~/agent-sandbox/ogad/run-ogad.sh    # OGAD dev app on :99, sandbox profile, CDP on 9333
~/agent-sandbox/ogad/serve-cpu.sh start|stop   # LFM3 r16 roles on the CPU (cores 0-7), 127.0.0.1:8471-8473
~/agent-sandbox/ogad/bench.sh [tasks.json] [out]  # sign out, reset, start OGAD, unlock the Vault, run the bench
```

`bench.sh` signs the sandbox partitions out first, so every task has the Vault sign it in. Other
endpoints go in `BENCH_MODELS` (the `OFFGRID_WEBUSE_BENCH_MODELS` JSON). `ogad/vault-setup.mjs`
creates or unlocks the dev profile's Vault and adds the six logins. `ogad/prove-profiles.mjs`
opens each profile, fills its login from the Vault and checks the sign-in.

### Emailed one-time codes (OTP)

- `~/agent-sandbox/sandbox.sh otp on` (or `off`): the bank and airline sign-in ask for a 6-digit
  code after the password. The site emails it from `no-reply@offgrid-bank.test` /
  `no-reply@offgrid-air.test` to `alex@offgrid-mail.test`. Kept in `.env` as `OTP_LOGIN`; off by
  default, so the other tasks are unchanged.
- The mailserver's IMAP is on `127.0.0.1:1143` (this computer only). `ogad/connect-mail.mjs <cdp>`
  adds OGAD's email connection "Sandbox mail (IMAP)" for alex; `bench.sh` runs it after the Vault.
  In the app it is Connections → Email (IMAP), server `imap://127.0.0.1:1143`.
- `OTP=1 ./bench.sh ogad/bench-otp.json` turns the codes on and runs the OTP tasks:
  `otp-bank-balance`, `otp-bank-dispute`, `otp-airline-next-trip`, `otp-airline-bag`,
  `otp-airline-cancel` (format of `bench-train.json`: `{id, goal, profile}`).
- Every task on `bank` or `airline` meets the code page while OTP is on, so with `OTP=1` the
  existing bank and airline tasks also train the step.

Not yet set up: office editing in Nextcloud (Collabora). Four `calendar` tasks edit `.docx` or
`.xlsx` files or make charts (`paid-summarise_docs-02`, `paid-work_reports-02/03/04`), and they
need it. Files open read-only for now.

### Results, 22 Nov

**The harness, with a scripted model (`ogad/oracle.py`).** The oracle speaks the model contract
and runs a fixed script per task. Everything else is the real OGAD path: sandbox partition, Vault
fill, secret scrub, commit gate. All six profiles pass:

| task                      | what it did                                                  | seconds |
| ------------------------- | ------------------------------------------------------------ | ------- |
| `sandbox-mail-send`       | Vault sign-in, open Priya's mail, Reply, type, Send          | 14      |
| `sandbox-calendar-delete` | Vault sign-in, open "Lunch with Sam", Actions, Delete        | 10      |
| `sandbox-shop-pay`        | Vault sign-in, buy coffee beans again, "Place order"         | 11      |
| `sandbox-airline-cancel`  | Vault sign-in, XYZ789, "Cancel booking" (refund $189.00)     | 8       |
| `sandbox-bank-cancel`     | Vault sign-in, cancel Streamflix                             | 6       |
| `sandbox-forms-pay`       | Vault sign-in, pay fine PF-55821 ($65.00)                    | 8       |

- **Send, pay and delete go through inside a sandbox** without an ask. Checked in the apps: the
  reply is in alex's Sent folder, addressed to Priya, and "Lunch with Sam" is gone from CalDAV.
- **The model never sees the password.** Every request the oracle got is logged. The login page
  reaches the model as `textbox "Password" … : ••••••••`, and no request has a plaintext password.
- **The commit gate holds on a public site.** `bench-gate-public.json` (no profile) filled the
  httpbin pizza form, then asked to click "Submit order". The click never ran. The task waited on
  the ask until the time limit, and the final page was still the filled form.

**LFM3 r16 on the CPU** (`serve-cpu.sh`). The real model ends all six tasks without success:

- mail, airline: it tries to type into the password field. The harness blocks this
  (`sensitive_field`). It should click Sign in after the Vault fill.
- calendar: it keeps pressing Enter.
- shop, bank: stale refs.
- forms: it clicked the same submit 183 times until the time limit. That run found a form bug,
  now fixed.

Findings for the harness:

- The loop guard misses a repeated click after a reload, because the refs get a new frame
  prefix.
- `SIGNED_IN=1` sign-ins do not survive an app restart (session cookies), so `bench.sh`
  starts signed out.
- A gate ask is not written to the bench record. It shows up only as a stop at the time limit.
