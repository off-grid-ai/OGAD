# Competitive and prior-art research - the proactive assistant

Researched August 2026. Every facet of what we are building has prior art; none of the incumbents ship the whole loop, and two big pieces are open whitespace. This is reference material for product and design. Sources are linked inline.

## Three strategic findings (read first)

1. **Local-first is open whitespace, and the market just proved why it matters.** The two flagship local screen/audio-memory products both got acquired by Meta in Dec 2025 and effectively ended as local products (Rewind capture disabled Dec 19 2025; Limitless pendant pulled). Dot (New Computer), a beloved memory-driven companion, shut down Oct 2025 and users "grieved" lost months of context. The lesson every Rewind-alternative now leads with: **local means your memory survives the vendor and never leaves the device.** Screenpipe (local SQLite + OCR + on-device model, MIT) is the architecture to benchmark against. This is our moat, validated the hard way.
   - https://the-gadgeteer.com/2026/05/05/best-ai-wearables-2026/ · https://techcrunch.com/2025/09/05/personalized-ai-companion-app-dot-is-shutting-down · https://github.com/screenpipe/screenpipe

2. **"Resolve the reference, show the evidence, confirm before acting" is essentially unshipped.** Every assistant resolves a vague reference the same way (hybrid retrieval -> rerank -> LLM answer) and shows provenance as *post-hoc citations*. None show ranked candidates with the evidence for each, surface a confidence, and ask you to confirm the pick *before* acting. Shortwave computes per-feature confidence and discards it. Gmail's forgotten-attachment detector is the only shipping confirm-before-send gate, and it cannot even name the file. **The thing our approval card does - "Send Q3.pptx to Ali because you called it 'the deck' in Tuesday's call and it is the only deck shared with Ali" - is the exact whitespace.**
   - https://arxiv.org/abs/2503.15739 (ECLAIR) · https://arxiv.org/abs/2206.07836 (PEL/CREL) · https://patents.google.com/patent/US10812427

3. **The GUI-automation reliability ceiling is real, and everyone hit it in 2026.** Google killed Project Mariner (May 2026) - screenshot-per-step vision was too slow, costly, and error-prone at scale. OpenAI quietly killed ChatGPT travel checkout (~Mar 2026) - "travel was too hard." Perplexity Comet's agentic mode is "wildly inconsistent" ("faster to do it yourself"). This validates our whole architecture: **route to the cheapest reliable rail, prefer demonstrated traces over novel automation, and gate everything.** Do not bet the product on pixel-level autonomy.
   - https://en.wikipedia.org/wiki/Project_Mariner · https://www.tourismtribe.com/chatgpt-instant-checkout-travel-operators/ · https://www.eesel.ai/blog/perplexity-comet-reviews

---

## 1. Proactive surfacing (the "come-up")

**Who does it:** Rewind/Limitless and Microsoft Recall (recall, not proactive push), Screenpipe (local infra), Apple Siri Suggestions / Call Context, Google **Magic Cue** + **Daily Hub** (Pixel), Microsoft Copilot ("Your Day at a Glance"), **ChatGPT Pulse** (the reference morning-briefing), Martin / Ohai (act + reach you in your channel).

**The recurring patterns (what to copy):**
- **The morning card feed** - a once-daily, scannable set that owns "the first five minutes of your day." Pulse, Daily Hub, Copilot, OpenClaw's briefing all converge here. Value is *density and relevance per card, not volume*.
- **Inline point-of-need chip (the best pattern)** - Magic Cue surfaces the thing *where you are already acting* (a chip in the message box, a confirmation code on the call screen), single tap to use, no feed to visit. Preferred over a feed for actionable items.
- **Notification -> answer-ready, never a dead alert** - Copilot's push opens straight into the pre-run answer and next action. Never surface "you have items waiting" with a blank prompt behind it.
- **Feedback + forward-preview** - Pulse ends each briefing previewing tomorrow's topics with a "curate" control, so the feed feels steerable.
- **Recall is a separate surface** - the scrubbable DVR timeline (Recall, Screenpipe) is for "find what I saw," kept distinct from the proactive push.

**The hard constraint - the notification budget.** Independent research and Pulse's own complaints converge: **~3-5 unsolicited notifications/day total is the ceiling**; exceeding it means users mute by Friday. "Notifications sent is a vanity metric; dismissals look like engagement but predict churn." An interruption costs ~23 minutes of recovery. Prescription: a hard daily cap the surfacing engine must respect, value-vs-attention scoring per candidate, learned per-user dismiss thresholds, and displacement logic (a new item must out-rank the queued one to fire). Treat each notification as a withdrawal from a finite account.
   - https://tianpan.co/blog/2026-05-13-background-agents-notification-budget-attention-economy · https://www.platformer.news/chatgpt-pulse-proactive-ai/

**Avoid:** a high-frequency engagement-optimized feed (Pulse's worst reviews: fatigue, "creepy," "my calendar does this free"); the come-up that only restates what the calendar/email already shows (the bar is *net-new synthesis*); over-automation without control (Motion's complaint); always-on capture without visible opt-in + encryption + per-app exclusions (Recall's 2024 near-death). Google's **Magic Cue** is the single best pattern to study.
   - https://store.google.com/us/magazine/magic-cue · https://9to5google.com/2025/08/20/pixel-10-magic-cue-launch/

## 2. Context resolution ("which deck did they mean")

**Who does it, and how (all the same shape):** ChatGPT memory + connectors (RAG over an index, live source sidebar), Gemini Workspace ("Sources" list, admits it "can make up a source"), **Glean** (the most sophisticated - a per-company entity knowledge graph that collapses variant names to one canonical identity, auditable traversal path), Microsoft 365 Copilot ("/" typeahead picker - the closest shipping "pick which one you meant", but only on explicit "/", not vague prose), Notion Q&A, Dropbox Dash, Slack AI (auto-extracts filters from a NL reference: author=Sarah, type=slides, last week), **Shortwave** (the best-documented pipeline: coref query-reformulation -> parallel feature extraction *with confidence* -> hybrid retrieval -> two-stage cross-encoder rerank).

**The whitespace (finding #2 above):** every product shows provenance as *post-hoc citation*, never a pre-action evidence panel with candidates + confidence + a confirm/correct control. Confidence is computed and thrown away. The research blueprint exists (ECLAIR interactive disambiguation; PEL/CREL personal-entity linking = coref to trace "the deck" back to its first mention + bind to the file entity - a two-step our on-device entity graph is well-suited to) but is unshipped in consumer products. **Caveat:** entity-reference ambiguity is only ~23% of real ambiguity - the rest is which *version*, which *date*, a missing constraint - so a resolver must handle more than the noun.

**The universal failure story:** confident wrong-source grounding. The Tow Center found >60% citation errors across AI search tools (ChatGPT ~67%); Google admits Gemini cites unused docs; Notion cannot reconcile duplicate/stale pages. The trust gap is precisely that these systems act on an unconfirmed pick and back-fill a citation users have learned not to trust. **Our answer:** show the evidence and confidence *before* acting, gate on it.
   - https://www.glean.com/perspectives/what-role-does-a-knowledge-graph-play-inside-modern-enterprise-ai-software · https://www.zenml.io/llmops-database/building-a-production-grade-email-ai-assistant-using-rag-and-multi-stage-retrieval · https://support.microsoft.com/en-us/microsoft-365-copilot/refer-to-specific-files-and-more-in-microsoft-365-copilot

## 3. Commitment / reasoned detection

**Email tools mostly do NOT do semantic "I promised X" detection - they detect the structural proxy "you sent mail, got no reply in N days":** Gmail/Gemini **Nudges** (the canonical *cautionary tale* - right idea, but on-by-default, breaks inbox order, induces guilt, fires on already-closed threads; the textbook example of resurfacing done annoyingly), Superhuman Auto Reminders (with the key anti-nag lever: scope to "external recipients only"), Spark, Boomerang, SaneBox (the quieter "no-replies folder" vs Gmail's loud inbox-bump - a useful design axis). **Mailbutler** does real semantic commitment extraction with urgency tiers; **Shortwave deliberately keeps task-creation manual** (human-confirm to avoid false-positive spam).

**Meeting-notes tools are where real "who owes what" extraction happens** (LLM over the transcript, owner by speaker, deadline from prose): Otter (cross-meeting dashboard, links to the transcript moment, weekly digest), Fireflies (cue-phrase extraction, ~90% after 2 weeks of correction, but speaker attribution "hit-or-miss"), Fathom (strong attribution, but **ownership is understood then lost at handoff** to task tools), Granola (uses your sparse notes as anchors to cut hallucination), Zoom (best-practice format "Owner + verb + deliverable + date"). **Failure mode to design against:** hallucinated action items and invented commitments ("assigned stories they didn't agree to write") - so link every extracted commitment to its exact source utterance and keep a confirm step.

**The durable formal model** (Microsoft Research, HP Labs): a commitment is a **commissive speech act with a debtor (who owes), a creditor (who is owed), and an optional deadline**, detected at the *sentence* level. That cleanly gives our two lists: "you owe" (user is debtor) and "waiting on" (user is creditor). Commitment vocabulary generalizes across domains (so a bundled local model is plausible) but models overfit, and precision tops out ~80-90% = **1 in 5-10 flags is wrong** - which is exactly why every shipping product hedges ("suggested"), batches into a digest, or requires a human confirm.
   - https://www.microsoft.com/en-us/research/blog/email-overload-using-machine-learning-to-manage-messages-commitments/ · https://techcrunch.com/2018/06/15/gmail-proves-that-some-people-hate-smart-suggestions/ · https://www.careful.industries/blog/2025-11-nine-risks-caused-by-ai-notetakers

**Anti-nag levers actually used:** granular independent opt-outs; scope narrowing ("external only"); batching over real-time; hedged framing ("suggested," not "your tasks"); human-confirm-before-commit; urgency tiers as a soft confidence gate; link every item to its source. The louder the surface, the more a false positive hurts.

## 4. Routines / teach-by-demonstration

**The two failed ends of the spectrum:** coordinate/pixel replay (Apple Automator **"Watch Me Do"** - it *observed* via the accessibility tree then *replayed* via absolute coordinates, "playback continues regardless" of drift; that one choice is the entire failure mode) and pure-vision replay (Mariner - "learn the plan not the pixels" was the right idea but cloud vision every step was too slow/costly/error-prone to ship). **Our AX-anchored trace + memory-filled slots + local model sits in the gap both missed.**

**Best authoring patterns (Apple Shortcuts, Keyboard Maestro, BetterTouchTool):**
- **Magic Variables** (Shortcuts) - every action's output is automatically a droppable, icon-tagged token you click to reinterpret. Best data-flow UX in the field.
- **Ask Each Time** (Shortcuts) - the simplest run-time slot; prompt when the value is not known. Pair with memory-fill: *resolve the slot from memory if known, fall back to Ask Each Time.*
- **Named Triggers with passed variables** (BTT) - the routine as a function with named arguments, invocable by many triggers; **Conditional Activation Groups** = context predicates gating when it may fire.
- **Use Model as one action in the stack** (Shortcuts, iOS 26) - Apple's own "an LLM step inside a deterministic routine," not "the model runs everything." Mirror this for slot-filling.
- **The reliability spectrum shown to the author** (KM: AX/semantic > found-image > coordinates, with "not found -> empty string -> branch").

**The RPA recorders are the gold standard for element anchoring and self-healing** (UiPath, Power Automate Desktop, Automation Anywhere):
- **Descriptor = target + anchors, not a bare selector.** UiPath's Unified Target captures the element *plus* 1-3 stable neighbor elements, with type-aware anchor selection (input -> label to the left/above via aria-labelledby; checkbox -> right). For an AX trace, record the target AX node **plus its labeling neighbor(s)**.
- **A redundant stack of targeting methods that race, first-match-wins** - strict path, fuzzy/Levenshtein match, visual/CV fallback - never a single point of failure, never raw coordinates except last resort. Critical refinement (Selenium's lesson): make the fallbacks *different in kind* (semantic + text + structural + visual), so one redesign cannot kill all at once.
- **Self-healing fires at the failure boundary, not the happy path.** UiPath **Healing Agent** and PAD **self-healing** (GA/preview 2025-26) run only after the element times out, give the model the **screenshot of the missing element + parent-window title + full-screen image**, and regenerate a fresh selector preserving intent. PAD runs this with GPT-4.1-mini + Claude Sonnet 4.5 - **a local model doing the same visual-grounding + AX-tree reasoning is a direct fit for our on-device design.** Two modes (auto-fix vs propose-for-approval), and the healed descriptor is *persisted* so the routine self-improves. Cascade cheap heuristics (close overlays, adaptive waits, semantic relabel match) before the LLM.
- **Record-with-narration** (PAD "Record with Copilot") - the user demonstrates while narrating; video + audio + UI metadata -> a flow with conditions and loops. The closest analog to us; voice narration disambiguates intent and variable slots that pure action capture cannot infer.

**The one-line macro-vs-smart test:** if changing a button's CSS class, moving it in the DOM, or swapping its tag breaks the routine, it is a macro. If it still finds the control a user would call "Submit" and can re-derive it from accessibility semantics, it is smart.
   - https://www.dssw.co.uk/blog/2014-11-10-automator-watch-me-do/ · https://support.apple.com/guide/shortcuts-mac/variable-types-apdd2b316022/mac · https://www.uipath.com/blog/product-and-updates/technical-tuesday-how-healing-agent-solves-ui-automation-challenges · https://learn.microsoft.com/en-us/power-automate/desktop-flows/self-healing · https://learn.microsoft.com/en-us/power-automate/desktop-flows/create-flow-using-ai-recorder

## 5. Confirm-before-acting (the gate)

**Two distinct designs exist:**
- **Inline pause + human takeover** (OpenAI Operator, Gemini Auto Browse, Comet) - the human re-enters the surface to type sensitive data or press the final button; the "edit" is "do it yourself."
- **Structured resolved-action card** (Manus Plan Mode, OpenAI Agents SDK / LangChain approval interrupts, mrmr, NN/g "Intent Preview") - shows resolved parameters (To / Subject / Body, amount, file, date) with Proceed / **Edit** / Cancel. **Manus is the standout**: "click into the plan and rewrite anything; when you Confirm, that plan becomes the source of truth." **Editing the resolved value is the differentiator** - most agents make you take over instead. Our card maps to this pattern.

**Converged rules across everyone:**
- **Handoff for sensitive steps is universal** - payments, logins, CAPTCHAs -> human takeover; do not screenshot what the user types in takeover; use stored credentials only with permission; route payment through a tokenized intermediary; decline some categories (banking) outright.
- **Calibrate friction by reversibility, not uniformly** - auto-do the reversible long tail, confirm the sensitive, hard-gate the irreversible. "Confirm everything" measurably degrades into rubber-stamping (Anthropic's own data: full auto-approve drifts from ~20% of new-user sessions to >40% for experienced users). A user-set autonomy dial (Suggest / Confirm / Auto) is the emerging control.
- **Enforce the confirm deterministically, below the model.** Every real incident (Replit deleting a prod DB despite an approval rule; Comet's OTP exfiltration; Manus SilentBridge) proves a prompt-level "ask first" instruction is not an enforcement boundary. The card must gate the actual side-effecting call and match that exact action and its exact arguments, so injection or model drift cannot act on values the user never saw.

**The #1 trust killer - false confirmations.** It appears in every task-doer: Ohai "tells you it completed tasks it hasn't," Comet "booked a hotel for the wrong dates," ChatGPT's "invented confirmations when the backend fails," Alexa+ got both Uber addresses wrong. **An agent must return a real backend confirmation record, never a model-generated "done."** Bake this in: our post-action toast must reflect the actual result of the executor call, never the model's claim.
   - https://manus.im/blog/manus-plan-mode · https://getmrmr.com/blog/approval-fatigue · https://www.anthropic.com/research/measuring-agent-autonomy · https://brave.com/blog/comet-prompt-injection/ · https://www.nngroup.com/articles/impressions-chatgpt-agent/

---

## What this means for us

Our design holds up remarkably well against the field; several of our choices are the exact documented best-practice (route to cheapest rail, demonstrated traces over novel automation, gate everything, memory as the moat). Concrete things to fold in:

1. **Own the two whitespaces**: local-first (memory survives the vendor) and **context-resolution-with-evidence-and-confidence-shown-before-acting**. The approval card that shows *why* it resolved a value is the single most differentiated thing we can ship, and nobody has it.
2. **Make the notification budget a real module** (hard 3-5/day cap, value-vs-attention scoring, learned dismiss thresholds, displacement) - test it as a pure ranking unit. This is the difference between "proactive" and "muted by Friday."
3. **The gate must show a real confirmation, never a model "done."** Wire the post-action toast to the executor's actual result. This is the field's #1 trust failure and it is cheap to get right.
4. **Self-healing = AX-anchor (target + neighbor anchors) + racing heterogeneous fallbacks + LLM recovery at the failure boundary, with the healed descriptor persisted.** The local model does what PAD does with GPT-4.1-mini + Claude. Two modes: auto-fix vs propose-in-review.
5. **Anti-nag levers**: scope ("external only"), quiet folder vs loud bump, batching, hedged "suggested" framing, and link every commitment to its source utterance. Commitment precision is ~80-90%, so 1 in 5-10 is wrong - never auto-act on a detected commitment without the gate.
6. **Recorder**: consider narrate-while-demonstrating (PAD "Record with Copilot") to disambiguate slots; present the trace as an editable draft of semantic cards (not an event log); Magic-Variable-style tokens + Ask-Each-Time slots that resolve from memory.

**For the demo brief specifically:** Screen 2 (the approval card) is where our differentiator lives - it must show the *evidence and confidence* for each resolved value, not just the resolved value. Add a low-confidence/disambiguation state (the ECLAIR "did you mean A or B" with evidence per candidate). That is the screen no competitor can show.
