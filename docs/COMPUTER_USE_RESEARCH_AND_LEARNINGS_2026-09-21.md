# Computer Use Research and Engineering Learnings

**Date:** September 21, 2026  
**Scope:** Off Grid AI Desktop on macOS and Windows  
**Purpose:** Preserve the external research, local run findings, architecture conclusions, and benchmark plan for the Computer Use reform.

## Executive summary

- Fast Computer Use systems use a small model as a bounded selector, not as a general planner.
- Code must construct complete legal actions before the selector runs.
- Accessibility is the fast primary observation. OCR and vision cover missing or unreliable accessibility data.
- A reasoning model is useful for planning, recovery, and ambiguous text. It is too slow for every action.
- Each action needs a fresh observation and an action-specific verification result.
- Our native action layer has improved, but the current policy layer has become a large rule engine.
- The current branch does not typecheck. Five of seven new factorization tests fail.
- BrowserGym and OSWorld adapters exist, but the requested MacArena adapter does not exist.

## 1. The question we are answering

We want reliable and usable Computer Use for tasks that can require 100 to 150 actions.

The system must:

- run locally;
- support macOS and Windows;
- remain fast enough for real use and a public demonstration;
- use the existing Decider, reasoning, accessibility, OCR, and vision capabilities;
- recover from incomplete accessibility data;
- avoid claiming success after an unrelated screen change;
- improve through measured benchmark results, not task-specific rules.

The important question is not which single model can do the whole task. The important question is how to assign the correct work to each model and deterministic subsystem.

## 2. Evidence labels

This document uses three evidence labels:

- **External fact:** A statement supported by a linked primary source.
- **Repository fact:** A statement supported by the current Off Grid AI repository or a command result.
- **Inference:** An architecture conclusion drawn from those facts. It is not presented as a measured result.

Demonstration results and vendor claims are not treated as independent benchmark results.

## 3. What external systems show

### 3.1 Cua Driver is a driver and harness surface

**External facts**

- Cua describes the model, agent harness, and driver as separate layers.
- Cua Driver exposes the real computer to an agent. It does not select or run the model.
- It supports macOS, Windows, and Linux.
- Its screenshot compatibility mode requires a process ID and window ID. This binds the image to the intended window.
- Its SDKs and MCP tools share the same native runtime and typed contracts.

Sources:

- [Cua Computer Use concepts](https://github.com/trycua/cua/blob/main/docs/content/docs/concepts/what-is-computer-use.mdx)
- [Cua Driver README](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md)

**Learning for us**

Cua is not a replacement model. It is a clean driver boundary. Copying the useful implementation means copying contracts and lifecycle rules, not replacing our complete stack with a new planner.

The useful contract is:

1. Observe one exact app and window.
2. Build legal actions from that observation.
3. Let a policy select one action.
4. Validate the selection against the same observation.
5. Execute it through the native driver.
6. Observe again.
7. Verify the expected effect.

### 3.2 The Cua and Jev proposal defines the correct System 1 boundary

**External facts**

The September 17 Cua RFC proposes this explicit boundary:

- capture and perception stay separate;
- one capture belongs to one action;
- the client builds complete bounded driver actions;
- Jev selects only a candidate ID;
- the client validates the selected ID;
- the driver executes it;
- the client observes again;
- Jev provider logic remains above and outside the driver.

Source: [Cua optional perception and jev-use RFC](https://github.com/trycua/cua/issues/3931)

**Learning for us**

Our Decider can fill the Jev role. We do not need Jev to use the architecture.

The Decider should not:

- invent a coordinate;
- generate free text;
- interpret a full historical transcript;
- decide whether an action was executed correctly;
- own retries;
- own safety policy;
- produce a multi-step plan.

The Decider should select one ID from a small set of valid, complete actions and return its distribution.

### 3.3 Public Jev examples confirm the bounded-choice design

**External facts**

The TypeSafe browser example:

- reads the page once for each cycle;
- assigns code-owned IDs to real elements;
- builds action groups such as click, type, select, scroll, wait, done, and blocked;
- asks one operation question and target questions;
- consumes only the target head that matches the chosen operation;
- resolves singleton choices in code;
- selects text for typing only when the type action is chosen;
- validates replies and target guards before execution;
- logs the candidate table, full distributions, confidence, latency, execution result, and rejection reason.

The example also states that it is a limited demonstration, not a general benchmark.

Source: [TypeSafe Jev browser agent guide](https://github.com/TypeSafeAI/typesafe-playground/blob/main/docs/jev-browser-agent.md)

The independent `typesafe-computer-use` project reports fast and low-cost decisions, but it also states the main limitation: deterministic code must provide reasoning that a frontier model would otherwise perform. Its timing and price numbers are project measurements, not a general benchmark.

Source: [typesafe-computer-use](https://github.com/awlevin/typesafe-computer-use)

**Learning for us**

The selector is fast because its problem is small. If we make it parse a long task, infer hidden state, generate text, and choose a target at the same time, we remove the property that makes a System 1 model useful.

### 3.4 Qwen open-computer-use uses a hybrid observation

**External facts**

Qwen's open-computer-use project:

- supports macOS, Windows, and Linux;
- uses operating-system accessibility APIs;
- provides a current app state tool;
- can attach a screenshot to the state and to post-action results;
- preserves element indexes across a sequence in one process;
- keeps the accessibility tree available when screenshot capture times out;
- bounds screenshot dimensions and encoded size.

Source: [Qwen open-computer-use README](https://github.com/QwenLM/open-computer-use/blob/main/README.md)

**Learning for us**

Accessibility and screenshots are complementary. A screenshot is not required for every normal action, but the harness must be able to request one without changing the execution architecture.

The accessibility observation should remain useful when capture fails. Vision should not be a mandatory dependency for structured actions.

### 3.5 Qwen reasoning parameters are part of the model contract

**External facts**

The Qwen3.8-27B model card recommends:

- thinking mode: `temperature=1.0`, `top_p=0.95`, `top_k=20`, `min_p=0.0`, `presence_penalty=0.0`, and `repetition_penalty=1.0`;
- non-thinking mode: `temperature=0.7`, `top_p=0.80`, `top_k=20`, `min_p=0.0`, `presence_penalty=1.5`, and `repetition_penalty=1.0`;
- preserved thinking by default for multi-turn work;
- explicit reasoning effort to balance quality and latency;
- enough output tokens for agent tasks.

It also warns that lower reasoning effort can reduce per-turn time but increase retries and total task time.

Source: [Qwen3.8-27B model card](https://huggingface.co/Qwen/Qwen3.8-27B)

**Learning for us**

These settings apply to the reasoning model. They do not imply that a 27B reasoning model should run for every click.

The correct split is:

- Decider: bounded, short, non-generative selection loop;
- reasoner: task decomposition, ambiguous state interpretation, recovery, and completion review;
- writer: bounded free-text generation only when literal task text is not available;
- specialist vision model: visual grounding only when structured evidence is insufficient.

Disabling thinking on a call that is intended to perform reasoning works against the documented Qwen contract. Disabling thinking can still be correct for a narrow writer or formatter call.

### 3.6 UI-TARS shows the strength and cost of direct visual policies

**External facts**

UI-TARS reports:

- 42.5% on OSWorld with a 100-step limit;
- 42.1% on Windows Agent Arena with a 50-step limit;
- strong ScreenSpot grounding results;
- limitations from computation, hallucination, element misidentification, and suboptimal actions.

These are project-reported results and must be compared only under the stated benchmark settings.

Source: [UI-TARS README and reported benchmark table](https://github.com/bytedance/UI-TARS)

**Learning for us**

Vision models are valuable when:

- the accessibility tree is empty;
- a canvas or custom-rendered control has no semantic node;
- OCR sees a label that AX does not expose;
- a structured action failed and needs visual recovery;
- geometry or layout is the task.

They are not the best default for every step on local hardware. Image encoding, prefill, visual inference, and coordinate generation add latency. Repeated visual calls also create more opportunities for coordinate drift.

### 3.7 OpenCUA shows another valid but slower architecture

**External facts**

OpenCUA's default OSWorld agent uses screenshots, reflective long chain-of-thought, and next-action generation. Its published command uses a 100-step limit and three images.

Source: [OpenCUA repository](https://github.com/xlang-ai/OpenCUA)

**Learning for us**

This is a valid architecture for a capable vision-language model on suitable hardware. It is not the same latency target as a local System 1 loop. We can use this type of model as a recovery or supervisory route without making it the steady-state action loop.

### 3.8 BrowserGym is useful, but it does not prove native desktop quality

**External facts**

BrowserGym supports MiniWoB, WebArena, WebArena Verified, VisualWebArena, WorkArena, AssistantBench, WebLINX, OpenApps, and TimeWarp. It is a web-agent research framework.

Source: [BrowserGym repository](https://github.com/ServiceNow/BrowserGym)

**Learning for us**

MiniWoB is useful for fast diagnostics:

- candidate recall;
- target selection;
- form operations;
- action latency;
- no-progress recovery.

It does not prove macOS or Windows native-app behavior. A good MiniWoB result can hide window identity, menu, dialog, focus, accessibility, and OS actuation defects.

### 3.9 MacArena is the correct current macOS baseline

**External facts**

MacArena provides:

- 421 human-verified tasks;
- 50 applications;
- Apple Silicon virtual machines;
- a clean snapshot for each episode;
- screenshots with optional accessibility trees;
- deterministic evaluation from files, app state, and shell output;
- a published baseline condition of 15 maximum steps and two runs per task.

Its reported baseline success rates vary greatly by application and task source. No baseline solves the benchmark. Multi-app tasks are especially weak.

Source: [MacArena project and results](https://research.macpaw.com/projects/macarena)

**Learning for us**

MacArena should be an unchanged external evaluator. We should adapt our production harness to its observation and action protocol. We should not add MacArena task phrases or app-specific solutions to production policy.

The published 15-step condition tests short-horizon desktop competence. It does not prove 100-step reliability. It is still the best first macOS comparison because it gives us a public baseline and deterministic success checks.

### 3.10 OSWorld tests a different and longer desktop condition

**External facts**

OSWorld provides real desktop tasks and can expose an accessibility tree. OSWorld 2.1 requires matching pinned code, tasks, assets, websites, and provider images for reproducible results.

Sources:

- [OSWorld repository](https://github.com/xlang-ai/OSWorld)
- [OSWorld 2.1 repository](https://github.com/xlang-ai/OSWorld-V2)
- [OSWorld server accessibility support](https://github.com/xlang-ai/osworld-server)

**Learning for us**

OSWorld is useful after the production loop works. It can test longer Linux desktop tasks and recovery. It cannot replace MacArena for macOS, and it does not prove Windows UIA behavior.

## 4. Where each approach wins

| Case | Best primary route | Why |
| --- | --- | --- |
| Standard native control with a good AX or UIA node | Native structured action | Fast, exact, and easy to verify |
| Browser form with semantic elements | DOM or accessibility action | Stable target and direct value checks |
| Simple next-step choice from known actions | Decider/System 1 selector | Low latency and full probability distribution |
| Task decomposition or ambiguous recovery | Reasoning model | Needs state interpretation and look-ahead |
| Text copied or quoted in the user goal | Deterministic literal extraction | No generation error or model delay |
| New prose that must be written | Bounded writer model | Generation is necessary, but can stay outside selection |
| Canvas, icon-only UI, game, or dead accessibility tree | Vision specialist | Pixels contain information missing from AX/UIA |
| Final task success | Deterministic evaluator or exact state query | A model claim is not proof |
| Sensitive or irreversible operation | Policy gate and user approval | Safety must be below the model |

No single observation or model wins every case. The harness wins by routing each case to the cheapest reliable route.

## 5. What we learned from our own runs

### 5.1 Long Decider prompts destroy the System 1 advantage

**Repository and run observations**

- Earlier calls included task text, plan context, guidance, large element lists, and history.
- The selected Decider has a small useful context compared with a large reasoning model.
- Large prompts increase prefill time and can remove later candidates through truncation.
- The current reform added `buildElementDecisionContext` with explicit character limits for the objective, guidance, candidates, and history.

Relevant code: [`ax-agent.ts`](../src/main/accessibility/ax-agent.ts)

**Learning**

The Decider packet should contain only:

- current milestone;
- exact app and window identity;
- current bounded action candidates;
- the last action and its verification result;
- current authoritative guidance.

Long-term history belongs in the reasoner. The selector needs current state.

### 5.2 A screenshot on every normal step is too expensive locally

**Repository and run observations**

- The existing vision path sends a screenshot and task context to a local or remote visual model.
- The repository already collapses old screenshots and keeps only the current one for UI-Mate.
- Local 27B reasoning and vision models have materially higher per-step latency than the Decider.
- Repeated visual decisions make an action loop slow even when each action is simple.

**Learning**

The steady-state loop should use structured observations. Capture should occur when:

- the structured tree is missing or contradictory;
- OCR or visual evidence is required;
- an action fails verification;
- completion cannot be established from structured state;
- the selected action depends on geometry.

This is a routing rule, not a ban on screenshots.

### 5.3 Accessibility is necessary but incomplete

**Observed failure classes**

- some controls have no useful name;
- some custom surfaces expose no actionable nodes;
- duplicate labels require region, hierarchy, state, or neighbor context;
- transient menus and dialogs can belong to a different process or window;
- focus can move after the observation;
- element geometry and indexes can change after an update;
- AX and OCR can describe the same visible control with different text;
- Windows UIA and macOS AX expose different state and action capabilities.

**Learning**

The candidate identity must include native stable identity when available. Geometry is evidence, not the sole identity. Each candidate must remain bound to its source observation, process, window, and capture generation.

AX/UIA candidates need normalized fields for:

- role;
- accessible name;
- value;
- enabled state;
- focus;
- checked and selected state;
- expanded or popup state;
- native supported actions;
- bounds and region;
- stable native identifier;
- source and source observation ID.

### 5.4 OCR is evidence, not automatically an executable control

**Repository observation**

The current implementation can create OCR-only candidates as non-executable evidence. However, a rule can later return a direct click on the OCR candidate, and validation accepts any OCR click.

Relevant code:

- [`ax-decision.ts`](../src/main/accessibility/ax-decision.ts)
- [`ax-host.ts`](../src/main/accessibility/ax-host.ts)
- [`ax-ranking.ts`](../src/main/accessibility/ax-ranking.ts)

**Learning**

OCR-only action needs a separate guarded route. It should require:

- a fresh capture;
- a confidence threshold;
- valid window-relative geometry;
- no strong conflicting AX target;
- an allowed action type;
- post-action verification.

The code must not mark all OCR clicks valid before these checks run.

### 5.5 MiniLM is retrieval support, not an action policy

**Repository fact**

The repository uses `all-MiniLM-L6-v2` as a 384-dimensional embedding model. It is documented under the embeddings API.

Relevant documents:

- [`API.md`](API.md)
- [`features/models.md`](features/models.md)

**Learning**

MiniLM can rank semantically similar labels or retrieve history. It cannot safely replace the Decider, reasoner, writer, or visual grounder. Similarity is not intent, action legality, state transition, or completion proof.

It can be one candidate-recall feature. It must not be the final policy.

### 5.6 The Decider is effective only when code has already solved legality

**Observed behavior**

- Factorized choices reduce the number of options in each question.
- Full probability distributions make abstention possible.
- Confidence is useful only when it is calibrated for the actual action family and risk.
- A selector cannot recover a valid target that candidate generation removed.

**Learning**

Candidate recall is upstream of policy accuracy. If the correct action is absent, no model can select it.

The harness must measure separately:

- target recall;
- action-family accuracy;
- target-selection accuracy;
- writer accuracy;
- validation rejection rate;
- execution success;
- verification accuracy;
- end-to-end task success.

### 5.7 Verification must be specific to the selected action

**Observed failure classes**

- a title change can be unrelated;
- any visible-text change can be unrelated;
- any accessibility-tree change can be animation, focus, time, or background state;
- an action can execute without producing the intended effect;
- repeating an uncertain action can duplicate text, messages, purchases, or files.

**Learning**

The expected postcondition must be owned by the candidate before selection.

Examples:

- `set_value(field, "Alice")` expects that exact field value;
- `toggle(checkbox)` expects that exact checked state to change;
- `select(option)` expects that option or its owner to become selected;
- `open(menu)` expects the named menu or popup to appear;
- `submit(form)` expects a specific state marker, not any screen change;
- `done` requires an independent task-level completion check.

The result vocabulary should distinguish:

- confirmed;
- partial;
- unverifiable;
- suspected no-op;
- refused;
- execution error.

Unknown is not success. Unknown also must not cause an unsafe automatic replay.

### 5.8 One hundred correct actions require much better than normal per-step accuracy

**Inference**

If every action were independent, task success would be approximately `p^n`, where `p` is per-step correctness and `n` is the number of required actions.

Examples:

| Per-step correctness | 50 actions | 100 actions | 150 actions |
| --- | ---: | ---: | ---: |
| 95% | 7.7% | 0.6% | 0.05% |
| 98% | 36.4% | 13.3% | 4.8% |
| 99% | 60.5% | 36.6% | 22.1% |
| 99.5% | 77.8% | 60.6% | 47.1% |

Real tasks are not independent, and recovery changes the calculation. The table still explains why verification and recovery are not optional. A small defect repeated 100 times becomes the dominant failure.

## 6. Audit of the current reform

This section describes the working tree audited on September 21, 2026.

### 6.1 Work completed well

- macOS AX extraction now exposes more state.
- Windows UIA now exposes focused, selected, and popup state.
- Native actions include hover, scroll, and numeric value setting.
- The Decider gets a bounded current-state packet.
- Action decisions retain probability distributions.
- Candidate-owned postconditions are used in more paths.
- Verification can compare structured state inside the same window.
- OCR is collected as part of the observation path.
- BrowserGym and OSWorld adapters provide useful diagnostic surfaces.

### 6.2 Architecture defects still present

#### Candidate loss

The implementation still limits candidates to 120 and slices several candidate lists.

Relevant code:

- [`ax-ranking.ts`](../src/main/accessibility/ax-ranking.ts)
- [`ax-observation.ts`](../src/main/accessibility/ax-observation.ts)
- [`ax-decision.ts`](../src/main/accessibility/ax-decision.ts)

This means a valid target can disappear before the Decider runs. Candidate compression should preserve reachability through groups or pages. It should not silently delete the tail.

#### Rule-engine growth

`ax-decision.ts` is now about 2,000 lines. The audit found 60 occurrences of rule-backed perfect confidence or the corresponding rules backend markers.

The rules cover sliders, consent, onboarding, clearing fields, hierarchical paths, search geometry, exact labels, menus, OCR targets, and completion phrases.

This is the central architecture regression. The System 1 selector is being replaced by a language-specific planner and benchmark-shaped heuristics.

Rules are appropriate for:

- legality;
- safety;
- deterministic singleton resolution;
- exact native capabilities;
- validation;
- known postconditions.

Rules are not appropriate for assigning artificial `1.0` confidence to broad interpretations of a user's goal.

#### Risk is not applied to the selected action

The final confidence threshold uses the reversible threshold for the decision family. It does not use the risk of the selected candidate.

Relevant code: [`ax-decision.ts`](../src/main/accessibility/ax-decision.ts)

#### OCR validation bypass

Any OCR click returns valid before the more specific OCR checks can run.

Relevant code: [`ax-host.ts`](../src/main/accessibility/ax-host.ts)

#### Weak verification

`window_state_change` accepts any serialized candidate-state difference. `visible_effect` accepts any changed visible text.

Relevant code: [`ax-verification.ts`](../src/main/accessibility/ax-verification.ts)

These checks can confirm unrelated changes.

#### Admission does not match the selected strategy

Preflight always requires the Decision model, and `decisionRuntimeAvailable` is hardcoded to true at the call site.

Relevant code:

- [`computer-use-preflight.ts`](../src/main/vision/computer-use-preflight.ts)
- [`ax-host.ts`](../src/main/accessibility/ax-host.ts)

#### Reasoning mode is disabled on recovery calls

Some calls that perform recovery or interpretation use `disableThinking: true`. This does not match the role assigned to a reasoning model or the Qwen model guidance.

Relevant code: [`ax-host.ts`](../src/main/accessibility/ax-host.ts)

### 6.3 Build and test status

Commands run during the audit:

```text
npm run typecheck:node
npx vitest run --project product-integration \
  src/main/accessibility/__tests__/ax-decision-factorization.test.ts \
  src/main/accessibility/__tests__/ax-ranking-state.test.ts \
  src/main/accessibility/__tests__/ax-verification-writer.test.ts \
  src/main/accessibility/__tests__/computer-use-replay.test.ts \
  src/main/accessibility/__tests__/windows-ocr.test.ts \
  src/main/accessibility/__tests__/ax-elements.test.ts \
  src/main/accessibility/__tests__/ax-uia-script.test.ts \
  src/main/vision/__tests__/computer-use-preflight-reform.test.ts
```

Results:

- Node typecheck failed with 14 errors.
- The focused suite ran 43 tests.
- 38 tests passed.
- 5 tests failed.
- All five failures were in the new factorized decision tests.
- The failures included valid action selection, editable-field routing, distribution retention, confidence abstention, and completion-family classification.
- `git diff --check` passed.

No end-to-end tests were run. The project instructions require explicit user authorization for them.

### 6.4 Benchmark status

The current work adds:

- a BrowserGym MiniWoB adapter;
- an OSWorld adapter and bridge;
- a replay script.

It does not add a MacArena adapter.

The replay script reconstructs a simplified candidate list and reads a recorded decision. It does not execute the production policy. It is useful for fixture inspection but cannot prove production decision accuracy.

The BrowserGym and OSWorld adapters reuse parts of the production agent, but they also duplicate model-server and observation translation logic. This creates drift risk.

## 7. The architecture we should implement

### 7.1 One production loop

```text
Task goal
  -> Reasoner creates or updates the current milestone
  -> Observer captures exact process/window state
  -> Candidate builder creates complete legal actions
  -> Decider selects one action ID or abstains
  -> Policy validates identity, freshness, risk, and confidence
  -> Native driver executes exactly one action
  -> Observer captures fresh state
  -> Verifier checks the action-owned postcondition
  -> Continue, recover, ask the user, or finish
```

Benchmark adapters must call this loop. They must translate environment observations and actions only.

### 7.2 Model roles

| Component | Required input | Required output | Must not own |
| --- | --- | --- | --- |
| Decider/System 1 | Current milestone and bounded complete actions | One action ID, probabilities, confidence, abstention | Planning, writing, coordinates, execution, verification |
| Reasoner | Goal, compact state, failures, relevant history | Milestone, recovery instruction, completion hypothesis | Direct unvalidated side effects |
| Writer | Field purpose and bounded source context | Text value | Target selection and execution |
| Vision specialist | Fresh screenshot and narrow visual question | Visual target or structured visual facts | General task history and final success |
| Deterministic code | Native state, policy, candidate contract | Legal actions, validation, execution, verification | Semantic guesses represented as certainty |

### 7.3 Candidate contract

Each candidate should contain:

```text
candidate_id
observation_id
process_id
window_id
action_type
target_id
arguments
description
source
risk
expected_postcondition
expiry_or_freshness_guard
```

The Decider should see a short description and ID. The executor should receive the full object from code after validation. The model must not reconstruct arguments after selection.

### 7.4 Candidate completeness without large prompts

Do not send all raw nodes to one flat choice. Do not silently delete nodes.

Use deterministic grouping:

1. Select action family.
2. Select region or semantic group.
3. Select the complete action within that group.

Every valid action must remain reachable through the hierarchy. Each level must retain its full probability distribution. Singleton levels should resolve in code.

### 7.5 Recovery ladder

Use the cheapest useful recovery:

1. Reobserve the same window.
2. Rebuild candidates from fresh AX/UIA state.
3. Use OCR evidence and rematch it to native nodes.
4. Ask the reasoner to interpret the failure and current state.
5. Use a fresh screenshot with the vision specialist.
6. Ask the user when the action is sensitive, ambiguous, or still unverifiable.

The ladder should be based on failure type. It should not invoke every fallback for every action.

### 7.6 Completion

Completion should require two different decisions:

- the policy proposes that the current milestone or task is complete;
- an independent verifier confirms the required state.

The verifier should prefer:

1. exact native state;
2. file or application state;
3. connector or tool result;
4. bounded visual verification;
5. user confirmation when no reliable check exists.

Visible success words alone are not enough.

## 8. Speed strategy

The objective is total task time, not only model latency.

### Fast path

- Reuse a warm Decider runtime.
- Keep one compact packet per decision.
- Resolve singleton choices without a model call.
- Extract literal task text without generation.
- Use native press, set-value, select, and scroll actions.
- Avoid screenshots for good structured state.
- Cache static metadata, but never reuse stale action state.
- Perform one action per fresh observation.

### Slow path

- Invoke the reasoner only for planning, ambiguity, recovery, and completion review.
- Preserve thinking when the selected reasoning model expects it.
- Use the model's documented sampling configuration.
- Give the reasoner enough output budget to finish its bounded job.
- Do not carry unbounded screenshots or transcripts across turns.

### Measurement

Record these times separately:

- capture;
- AX/UIA extraction;
- OCR;
- candidate construction;
- Decider prefill and generation;
- reasoner prefill and generation;
- vision inference;
- actuation;
- verification;
- recovery;
- total task time.

Without this split, a faster model can hide a slower capture or verification loop.

## 9. Benchmark plan

### 9.1 Fix correctness before comparative benchmarking

The benchmark gate should require:

- node typecheck passes;
- focused Computer Use tests pass;
- candidate reachability tests pass with more than 120 nodes;
- OCR-only clicks follow the guarded route;
- selected risk controls the confidence threshold;
- unrelated state changes do not confirm an action;
- replay uses the production candidate and policy functions;
- the benchmark adapter contains no task-name or expected-answer rules.

### 9.2 Use three benchmark levels

#### Level 1: deterministic component diagnostics

Measure:

- candidate recall;
- fusion and stable identity;
- action selection;
- confidence and abstention;
- verification;
- latency.

These tests locate defects quickly.

#### Level 2: BrowserGym diagnostics

Use MiniWoB for fast web-form and target-selection iteration. Keep the harness fixed while comparing revisions.

Do not report MiniWoB as native Computer Use performance.

#### Level 3: MacArena baseline

Build a thin MacArena adapter that:

- converts MacArena screenshot and optional accessibility observations into the production observation contract;
- converts one production action into the MacArena action format;
- maps production `done` and failure states to benchmark terminal actions;
- records the production trace and timing fields;
- leaves task setup and evaluation to MacArena;
- contains no alternative decision loop.

First reproduce the public 15-step, two-run condition. Then add separately named 50-step, 100-step, and 150-step conditions. Do not compare those extended conditions directly with the published 15-step baseline.

### 9.3 Report more than one success number

For every benchmark condition, report:

- exact repository commit and dirty status;
- model files and hashes;
- model parameters;
- operating system and hardware;
- benchmark release;
- task count and step limit;
- success rate by app and category;
- median and p95 action latency;
- total task time;
- action count;
- abstention count;
- reasoner, writer, OCR, and vision invocation counts;
- validation rejections;
- verification failures;
- recovery success rate;
- failure taxonomy.

This lets us tell whether a change improves grounding, reasoning, execution, verification, or only one benchmark category.

## 10. Rules that should not change during implementation

- Do not hardcode benchmark tasks, app names, or expected answers in production policy.
- Do not assign perfect confidence to semantic heuristics.
- Do not let the model invent an executable target outside the candidate set.
- Do not silently remove valid candidates.
- Do not execute a candidate from a stale observation.
- Do not treat any screen or tree change as proof of success.
- Do not repeat an unknown side effect automatically.
- Do not use embeddings as the final action policy.
- Do not call the large reasoner for each normal action.
- Do not disable thinking on calls whose purpose is reasoning unless a measured condition proves it is better.
- Do not let benchmark adapters create a second policy loop.
- Do not claim long-horizon reliability from a short-step benchmark.

## 11. Where we stand

The project has the correct major ingredients:

- a local fast Decider;
- local reasoning models;
- native macOS AX support;
- native Windows UIA support;
- OCR;
- vision fallback;
- native input actuation;
- supervised task controls;
- trace and task infrastructure.

The missing part is not another model. It is a strict contract between these ingredients.

The current branch improves observation and actuation, but it weakens the policy boundary by adding a large rule-driven decision layer. It also lacks passing build validation and the requested MacArena integration.

The best next change is therefore a consolidation, not another expansion:

1. restore a small bounded selector;
2. move semantic planning and recovery to the reasoner;
3. make candidate reachability complete;
4. make OCR actions explicitly guarded;
5. make verification action-specific;
6. use the production loop from replay and benchmark adapters;
7. add a thin MacArena adapter;
8. measure speed and success under fixed conditions.

That path uses the work already completed. It does not require Cua or Jev as dependencies. It adopts the architecture that makes those systems effective while retaining Off Grid AI's local models, cross-platform native layer, reasoning fallback, vision fallback, safety controls, and product integration.

