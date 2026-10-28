# Release test checklist — analytics + video

Pick up a device. Go to its section. Tick each box.

Every line is: **do this** → **you should see this**.
If you don't see it, it's a bug.

Start with **Everywhere**. Then do your device's own section.

---

## Everywhere — every computer and every phone

### Basics
- [ ] Install fresh and finish setup → app opens, no errors
- [ ] Send a chat message → reply streams in
- [ ] Open Models → the list loads
- [ ] Open every Settings tab → none is blank
- [ ] Search for something → results come back
- [ ] Quit and reopen → your chat and settings are still there

### Analytics is OFF until you say yes
- [ ] During setup → the "share anonymous usage" box is **unticked**
- [ ] Skip it → you are not asked again straight away
- [ ] Settings → Analytics → two switches (Usage data, Crash reports), both **off**
- [ ] Turn one on, then off → it stays the way you left it after a restart
- [ ] Settings → Analytics → What we share → two short lists, readable
- [ ] Settings → Analytics → Report a problem → the log opens, even with analytics off
- [ ] Make a model download fail → "Help us fix this?" pops up once. "Not now" makes it go away

### Video (needs Pro)
- [ ] On a **free** account → video shows "needs Pro", never an error
- [ ] On Pro → open Video → type an idea → **Make it** → it renders and plays
- [ ] Add a photo → you must tick "this is me / they agreed" before Make it works
- [ ] Press **Stop** mid-render → it stops cleanly
- [ ] Delete a video → it asks first, then it's gone (also from your other paired device)
- [ ] Delete a character → **it asks first** (new)
- [ ] Render on a paired computer → the screen says your photos go **to that computer** (new)

---

## Mac

- [ ] Make an image and a video → both work
- [ ] On **macOS 13** (if you have one) → image and video still work
- [ ] On an **Intel Mac** (if you have one) → app runs, image works
- [ ] Use voice (read-aloud) in the **downloaded release build**, not dev → it speaks
- [ ] Search your documents in the release build → results come back
- [ ] Computer Use → it asks for Accessibility and Screen Recording, then works
- [ ] Video → Share → the normal Mac share sheet opens
- [ ] Update from the previous version via auto-update → it installs

## Windows

- [ ] On an **AMD or Intel graphics** PC → chat, image and voice-to-text all work
- [ ] On an **NVIDIA** PC → chat, image and video all work in the same session
- [ ] On a **brand-new Windows** (nothing else installed) → app starts, chat works
- [ ] Install the performance pack → it downloads once, works after restart
- [ ] **Upgrade** a PC that already had the performance pack → it is **not** downloaded again
- [ ] Settings → engine picker → options make sense; greyed ones say why
- [ ] Old NVIDIA driver → says "driver too old", doesn't just fail

## Linux

- [ ] Install the **.deb** on a fresh Ubuntu 24.04 → installs and runs
- [ ] Run the **AppImage** on the same box → runs
- [ ] On **NVIDIA** → install the performance pack → app does **not** restart itself, and search/voice speed up
- [ ] Change a setting that restarts the app (AppImage) → it comes back
- [ ] Ubuntu 22.04 → app opens, chat works

---

## Android

Use **two phones** if you can: one **Snapdragon** (most Samsung / OnePlus) and one other.

- [ ] Make a video → a "Generating video" notification shows, with **Stop**
- [ ] Press Stop in the notification → it stops
- [ ] Lock the screen mid-video → come back → it kept going
- [ ] Deny notifications when asked → video and downloads still work
- [ ] Save a video → it lands in **Downloads**, visible in Files
- [ ] Snapdragon phone → video comes out normal (not black)
- [ ] Android **14** and **15** (if you have both) → video works on each
- [ ] Wan 2.1 and Wan 2.2 → offered like any other model, no "experimental" label (new)
- [ ] Phone under 11 GB RAM → video says "made on your computer" + **Find my computer**

## iPhone

- [ ] Make a video → it renders and plays
- [ ] Leave the app mid-video:
  - [ ] **iOS 26** → keeps going, progress shows in the system
  - [ ] **iOS 18** → stops, and tells you to keep the app open
- [ ] Animate a photo → the permission prompt explains it's for video too (new)
- [ ] Export a video → the share sheet opens
- [ ] Only **Wan 2.1** is offered for video (Wan 2.2 is Android only)
- [ ] Install from **TestFlight** → it installs (new background permission)

## Phone + computer together

- [ ] Pair the phone with Desktop → search from the phone finds things on the computer
- [ ] Start a very long reply from the phone → **Stop** it → the app is usable again, the next message works (new)
- [ ] Turn the computer off mid-request → **Stop** on the phone still gets you out (new)
- [ ] Make a film on the phone that renders on the computer → it comes back and plays

---

## Browser extension

Test in **Brave** and in **Firefox**.

- [ ] Not paired → it asks you to pair, nothing looks broken
- [ ] Desktop closed → "can't connect" + retry
- [ ] Sign in on any website → a card offers to save the password
- [ ] Change the username or password in that card → **what you typed** is what gets saved
- [ ] Empty the password and press Save → it refuses
- [ ] Site you've saved before → button says **Update**
- [ ] Vault → **Authenticator** tab → add one → you see a 6-digit code that changes
- [ ] Use it to fill a login → it fills only the code box
- [ ] Dark mode → the card is readable
- [ ] **Firefox only:** sign in on a site that jumps to a new page → the save card still appears there

---

## Old install — the bugs fresh installs hide

Use a computer and a phone that already have the **previous version** with chats, documents and models on them. Install the new version over the top.

**Computer**
- [ ] Open it → search works straight away
- [ ] Quit while it's busy re-indexing, reopen → it picks up where it left off
- [ ] Your documents still come up in search (they may take a while to come back)
- [ ] If you had **Pony Diffusion** or the **Lessac** voice selected → something sensible is picked, not a blank

**Phone**
- [ ] Open it → no crash on launch, Gallery or Storage
- [ ] Your chats, images and custom image settings are still there
- [ ] Your documents still come up in search
- [ ] Old voice-to-text and image models still load

---

## Website — read before it goes live

The site ships **with** the apps, never before.

- [ ] Read the **privacy policy** start to finish
- [ ] Read the **terms** start to finish
- [ ] Pricing page → $10 · $30 · $50 · $69 · $119 · $149, lifetime and monthly only
- [ ] Desktop, Mobile and Pro pages → video and analytics claims match the apps
- [ ] Skim 5 random blog posts → no sentence reads oddly after the wording change

---

## Still open — not a test, needs you

- [ ] Sign the **PostHog** data processing agreement
- [ ] PostHog project settings → turn on **Discard client IP data**. The privacy policy promises IPs are not stored; the apps only turn off location lookup
- [ ] PostHog project settings → set data retention to **12 months**. The privacy policy promises it
