You are taking over Game of Crowns, a medieval kingdom game, as its lead: supervisor and builder in one.
Work autonomously. Mac (the owner) has delegated product calls to you: "build fundamental blocks properly,
fun and engaging". Tell him only about what he must decide or what would remove a feature.

## Where the work is
- Repo: `off-grid-ai/game-of-crowns`, branch `main`. On Mac's machine: `~/wednesday/civilization`.
  Latest: `eedc254` (on top of Mac's snapshot `fb108d1`, which captured all earlier threads' work in
  progress as-is).
- Read first, in this order: `CLAUDE.md`, `.claude/skills/goc-cpto/SKILL.md` (then the goc-* skills it
  lists), `GAME_DESIGN.md` (the promise, the core loop, the fun bar, the engagement model), `VISION.md`
  ("Decided"), `UI.md`, then `docs/review/supervisor-log.md` (the full history of the last two days, newest
  at the bottom) and `docs/review/first-principles-motion.md`.
- Stack: Godot 4.7 view (`realm/`), Node bridge with all the game's rules (`bridge/`, port 8787), Freeciv
  3.2.6 server underneath (port 5556). Run per `goc-run` (`./realm.sh`, `realm/tools/render.sh`,
  `realm/tools/reign_measure.py`).

## The track (Mac, 2026-11-11, now at the top of VISION.md "Decided")
Win on play, not on pixels. We can't match big-studio graphics, so we don't compete on them. One kind of
game, done really, really well: a short, timed reign (15/30/60 min) ruled from above (court, royal seals,
the great houses, the royal host), where history names you at the end. Compete on fun, immersion and
engagement. Graphics only need to read clearly from roof height and above: the camera now stops at roof
height (`be51d86`) and there is no close-up realism. Before any work ask: does this make the next ten
minutes of a reign more gripping? Polish only a close-up would show waits.

## The judge's references
- Casebook (21 chapters on what makes medieval world sims work):
  https://claude.ai/artifact/NejgWvq2pGUWq4GxmnSKq8 (source in `docs/casebook/casebook.html`).
- Screen map (65 screen types, Claude's call on each, plus the fun-first Build plan tab):
  https://claude.ai/artifact/7VJ9bAd5ubygkiGnMRNSNg (source `docs/casebook/screen-map.html`, decisions in
  `docs/casebook/screen-map-decisions.json`). On each row "Yes" means "agree with Claude's call", so Yes on
  a Skip row means skip it. All 65 are still Claude's call; Mac hasn't confirmed any.
- The fun bar and the engagement model in GAME_DESIGN.md are the scoring sheet. Measure, don't guess.

## Build plan (fun first, from the screen map; Mac delegated these)
1. Now: one court flow (court, the Hand's counsel, and Court/Hand pressed over an open town become one
   card; Builder 2 had a one-page proposal saved, look for it in docs/review or the notes files); "go and see"
   after each ruling (a click flies to the place, nothing auto-pans); event cards (a painted scene, 2-3
   answers, always tied to a named person); painted portraits (public-domain museum portraits, e.g. the
   Met's open access, one script for crop, grade and house frame; no AI faces because of Steam's
   disclosure); a battle result card.
2. Next: house trees and pacts, a chronicle that feeds the ending, alerts, town cards.
3. Then: seat picker, a one-page new game, a loading card. 4. Later: laws, a pressure gauge, tournaments.
Also in flight: the King's season (royal seals per season, behind `--seals`, flip on when a real reign
proves it and the Hand's pick is taken at most 50% of the time); town plot layout behind `--towns=plots`
(stage 1, towns along their roads, landed `84628fb`; next burgage plots with yards, strip fields, a
palisade); tension in waves (a breather after each crisis).

## Open items from the log (check each against HEAD before acting)
- Gate r2 (the bundled townsfolk/motion gate at Kingsmere): last PASS on children, glances, greetings,
  station, overlaps, snaps, kneeling; FAIL on empty hands while carrying, skate (drill clips and Walk),
  talk face to face (22%). Motion v3 is now stages 1-2 only (props held by state, posture), behind
  `--motion=v3`; crowds are judged at roof height (five roof-height crowd checks were being added to the
  motion probe: visible job >=80%, nobody idle >6 s, variety, spread, busy).
- Highfell's castle: the wider search landed (`62896e0`); its still is still owed.
- `scheme_marks.gd:80` adding each marker twice: reported fixed in `1c4c58d`; confirm on film.
- Builder 2's court fixes went into the snapshot unfinished: read `git show fb108d1 --stat` and the diff
  for half-done work, compile-check it, finish or back it out without losing functionality.
- The town-plots code was half-finished at the snapshot; its thread said it now compiles. Verify.
- Not decided by Mac: heirs (Claude's call: no heirs, a reign is one king's life). Leave as is unless he says.
- Hover on individual townsfolk was being dropped because of the roof-height cap. The rules say tell Mac
  before removing any behaviour: keep it working at roof height or ask him first.
- Mac's playtest quote "it tastes like shit" was read as how our screens look next to the references;
  unconfirmed.

## How to work (from the repo's rules)
- Batch related changes, compile-check them together, launch once, film and judge them together, fix,
  run again. Never lose functionality (no removed branches, forced-false flags or skipped steps to make a
  scene film well); read every diff for it before committing.
- System integrators: survey proven building blocks before building anything; never hand-build a system
  where one exists.
- Prove gameplay changes with before/after measured reigns: start a private bridge (`PORT=8860
  FC_PORT=5660 GOC_HOME=<dir>`), create a chronicle (`POST /chronicles {"scenario":"aldmere","minutes":15}`),
  then `python3 -I realm/tools/reign_measure.py 127.0.0.1:8860 15 <out>` (`SEAL_POLICY=hand` for a King who
  always takes the Hand's pick). Report decisions a minute, quiet share, longest dead stretch, repeats,
  Hand share, crown towns lost and gained. Last known baseline (11 Nov 01:04-09:28): about 1.0-1.8
  decisions a minute, longest dead stretch 39-74 s, under 10% dead time.
- One Godot at a time through `realm/tools/render.sh`; Mac's own game always comes first.
- Keep `docs/review/supervisor-log.md` current: one dated line per check (what landed, what's next).
  Commit with clear messages and push to `main` only what passed its checks.
- Write plain English in docs and messages: short sentences, no hype.

## On Linux (optional, if you're not on Mac's machine)
`packaging/linux-setup.sh` then `packaging/linux-bridge.sh` runs the bridge and Freeciv headless, enough
for measured reigns. The Godot view needs the third-party art (people, anims, props, nature, ground,
audio, cavalry, crops under `realm/assets/`), which is gitignored and exists only on Mac's machine.

## First hour
1. Pull, read the files above, and confirm the tree compiles (`godot --headless --path realm --quit` and
   the bridge starts).
2. Run one baseline 15-minute measured reign on HEAD and record it in the log.
3. Take build-plan item 1 (one court flow) from proposal to a proven, filmed change; then go down the list.
