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
- **Visits.** Each bench record has `visits` (the task's page trail). `OFFGRID_AGENT_VISIT_HINT=1`
  adds one line to the prompt when a page was opened 3+ times. Off by default: the shipped models
  were not trained on it. Turning it on is a model-contract change.
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
