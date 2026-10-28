# Release test checklist — analytics + video

The work is split into **lanes**. Each lane is one thread with its own devices.

- **Lanes run at the same time.**
- **Inside a lane, steps run in order:** old install → checks → fresh install.

Every check is: **do this** → **you should see this**. If you don't see it, it's a bug.

---

## Lanes at a glance

| Lane | Thread | Devices | Can start when |
|---|---|---|---|
| **A · Phones** | mobile-blockers | OnePlus (Android) and iPhone, one agent each, **side by side** | iPhone is reconnected |
| **B · Mac** | border-cleanup | this Mac | sticky header is committed |
| **C · Browser** | ext-security | Brave and Firefox, **side by side** | its fixes land, and the Mac app is running |
| **D · Phone + Mac** | main thread coordinates | one phone + this Mac | A and B both reach step 2 |
| **E · Website** | website-pricing | the site on localhost:4100 | now |
| **F · Windows** | at the end | a remote Windows instance (one AMD/Intel, one NVIDIA) | everything else is verified |
| **G · Linux** | at the end | a remote Linux instance | everything else is verified |
| **You** | Ali | — | now |

## Order

```
            step 1         step 2                 step 3
A Phones    old install ─► core + Android/iPhone ─► fresh install
B Mac       old install ─► core + Mac ─────────────────────────────────► fresh install  (last of all)
C Browser                  fixes land ─► Brave + Firefox
D Together                 (A and B at step 2) ─► phone + Mac checks
E Website   read any time
F/G                                                                        remote instances, last
```

**Three rules**

1. **The Mac's fresh install goes last of everything.** The phones and the browser pair with the Mac. Wiping it unpairs them.
2. **Whoever restarts the Mac app tells the other lanes first.** A, C and D depend on it.
3. **A failure is a bug, not a skipped box.** The lane's thread fixes it on `release/analytics-video`.

---

## Core checks

Lanes A and B run these on every device, in step 2.

**Basics**
- [ ] Open the app → no errors
- [ ] Send a chat message → reply streams in
- [ ] Open Models → the list loads
- [ ] Open every Settings tab → none is blank
- [ ] Search for something → results come back
- [ ] Quit and reopen → your chat and settings are still there

**Analytics is off until you say yes**
- [ ] Settings → Analytics → two switches (Usage data, Crash reports), both **off**
- [ ] Turn one on, then off → it stays the way you left it after a restart
- [ ] Settings → Analytics → What we share → two short lists, readable
- [ ] Settings → Analytics → Report a problem → the log opens, even with analytics off
- [ ] Make a model download fail → "Help us fix this?" pops up once. "Not now" makes it go away

**Video (needs Pro)**
- [ ] On a **free** account → video shows "needs Pro", never an error
- [ ] On Pro → open Video → type an idea → **Make it** → it renders and plays
- [ ] Add a photo → you must tick "this is me / they agreed" before Make it works
- [ ] Press **Stop** mid-render → it stops cleanly
- [ ] Delete a video → it asks first, then it's gone (also from your other paired device)
- [ ] Delete a character → **it asks first** (new)
- [ ] Render on a paired computer → the screen says your photos go **to that computer** (new)

## Fresh install checks

Lanes A and B run these in step 3. Delete the app and its data first.

- [ ] Install and open → setup starts, no errors
- [ ] During setup → the "share anonymous usage" box is **unticked**
- [ ] Skip it → you are not asked again straight away
- [ ] Finish setup → the recommended models download and chat works
- [ ] Watch the network before you touch anything → nothing is sent to analytics

---

## Lane A · Phones — mobile-blockers

Android and iPhone run **side by side**, one agent per phone.

**Step 1 · Old install** — install the new build over the one already there and keep its data
- [ ] Open it → no crash on launch, Gallery or Storage
- [ ] Your chats, images and custom image settings are still there
- [ ] Your documents still come up in search
- [ ] Old voice-to-text and image models still load

**Step 2 · Core checks**, then:

*Android*
- [x] Stop a model load on a Desktop that never answers → request closes, row recovers, next pick works (new)
- [ ] Make a video → a "Generating video" notification shows, with **Stop**
- [ ] Press Stop in the notification → it stops
- [ ] Lock the screen mid-video → come back → it kept going
- [ ] Deny notifications when asked → video and downloads still work
- [ ] Save a video → it lands in **Downloads**, visible in Files
- [ ] Snapdragon phone → video comes out normal (not black)
- [ ] Android **14** and **15** (if you have both) → video works on each
- [ ] Wan 2.1 and Wan 2.2 → offered like any other model, no "experimental" label (new)
- [ ] Phone under 11 GB RAM → video says "made on your computer" + **Find my computer**

*iPhone*
- [ ] Stop a call on a Desktop that never answers → the app recovers, the next request works (new)
- [ ] Make a video → it renders and plays
- [ ] Leave the app mid-video:
  - [ ] **iOS 26** → keeps going, progress shows in the system
  - [ ] **iOS 18** → stops, and tells you to keep the app open
- [ ] Animate a photo → the permission prompt explains it's for video too (new)
- [ ] No Face ID prompt anywhere (new: the app no longer declares it)
- [ ] Export a video → the share sheet opens
- [ ] Only **Wan 2.1** is offered for video (Wan 2.2 is Android only)
- [ ] Install from **TestFlight** → it installs (new background permission)

**Step 3 · Fresh install checks**

---

## Lane B · Mac — border-cleanup

**Step 1 · Old install** — run the new build over the existing profile and keep its data
- [ ] Open it → search works straight away
- [ ] Quit while it's busy re-indexing, reopen → it picks up where it left off
- [ ] Your documents still come up in search (they may take a while to come back)
- [ ] If you had **Pony Diffusion** or the **Lessac** voice selected → something sensible is picked, not a blank

**Step 2 · Core checks**, then:
- [ ] Make an image and a video → both work
- [ ] Load an **LFM3** model → it chats, no "engine too old" (new)
- [ ] Models → Text → search **LFM3-VL** → it shows up; attach an image → it answers about it (new)
- [ ] Run a task, scroll its steps → the header with **Stop** stays on screen (new)
- [ ] Settings → UI → turn off hover and click animations → nothing moves on hover or click; turn it back on → motion returns (new)
- [ ] Models → the filter bars have no boxed outline (new)
- [ ] Computer Use → it asks for Accessibility and Screen Recording, then works
- [ ] Video → Share → the normal Mac share sheet opens

*Needs a signed release build, not the dev app:*
- [ ] Voice (read-aloud) → it speaks
- [ ] Search your documents → results come back
- [ ] Update from the previous version via auto-update → it installs

*If you have the machine:*
- [ ] **macOS 13** → image and video still work
- [ ] **Intel Mac** → app runs, image works

**Step 3 · Fresh install checks** — last of every lane

---

## Lane C · Browser — ext-security

Brave and Firefox run **side by side**. Both need the Mac app running.

- [ ] Start a task in the browser, keep working in another tab → **your tab never changes**, the task still finishes, and only done / pause / needs-you reaches you (new)
- [ ] **Take over** → the task's tab comes to the front (new)
- [ ] Not paired → it asks you to pair, nothing looks broken
- [ ] Desktop closed → "can't connect" + retry
- [ ] Sign in on any website → a card offers to save the password
- [ ] Change the username or password in that card → **what you typed** is what gets saved
- [ ] Empty the password and press Save → it refuses
- [ ] Site you've saved before → button says **Update**
- [ ] Login picker → a real **search box** at the top; typing filters; no matches says so (new)
- [ ] Vault → **Authenticator** tab → add one → you see a 6-digit code that changes
- [ ] Use it to fill a login → it fills only the code box
- [ ] Dark mode → the card is readable
- [ ] **Firefox only:** sign in on a site that jumps to a new page → the save card still appears there

---

## Lane D · Phone + Mac — coordinated

Starts when lanes A and B are both at step 2. Needs one phone and the Mac app.

- [ ] Pair the phone with Desktop → search from the phone finds things on the computer
- [ ] Start a very long reply from the phone → **Stop** it → the app is usable again, the next message works (new)
- [ ] Turn the computer off mid-request → **Stop** on the phone still gets you out (new)
- [ ] Make a film on the phone that renders on the computer → it comes back and plays

---

## Lane E · Website — website-pricing

The site ships **with** the apps, never before.

- [ ] Read the **privacy policy** start to finish
- [ ] Read the **terms** start to finish
- [ ] Pricing page → $10 · $30 · $50 · $69 · $119 · $149, lifetime and monthly only
- [ ] Desktop, Mobile and Pro pages → video and analytics claims match the apps
- [ ] Skim 5 random blog posts → no sentence reads oddly after the wording change

---

## Lanes F and G · Windows and Linux — last, on remote instances

Everything that isn't platform code is already proven on the Mac and the phones. These lanes run only the checks for code that differs on Windows or Linux.

**Windows**

- [ ] **AMD or Intel graphics** → chat, image and voice-to-text all work
- [ ] **NVIDIA** → chat, image and video all work in the same session
- [ ] **Brand-new Windows** (nothing else installed) → app starts, chat works
- [ ] Install the performance pack → it downloads once, works after restart
- [ ] **Upgrade** a PC that already had the performance pack → it is **not** downloaded again
- [ ] Settings → engine picker → options make sense; greyed ones say why
- [ ] Old NVIDIA driver → says "driver too old", doesn't just fail

**Linux**

- [ ] Install the **.deb** on a fresh Ubuntu 24.04 → installs and runs
- [ ] Run the **AppImage** on the same box → runs
- [ ] **NVIDIA** → install the performance pack → app does **not** restart itself, and search/voice speed up
- [ ] Change a setting that restarts the app (AppImage) → it comes back
- [ ] Ubuntu 22.04 → app opens, chat works

---

## You — not a test, only you can do it

- [ ] Sign the **PostHog** data processing agreement
- [ ] PostHog project settings → turn on **Discard client IP data**. The privacy policy promises IPs are not stored; the apps only turn off location lookup
- [x] PostHog plan → **free**, keeps events 1 year, matches the policy's 12 months. Before ever moving to a paid plan (7 years, cannot be shortened), change the policy first
- [ ] Reconnect the **iPhone** to the Mac when lane A asks
