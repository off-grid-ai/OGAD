# Off Grid AI - the assistant: TRD / PRD diagrams

**Status:** August 13, 2026. Diagrams for the assistant (the act pillar), in the Wednesday TRD + PRD house style.
These slot into the standard docs: **System Architecture (C4)** and **Sequence / Swimlane** go in the TRD; **User Flows** goes in the PRD. Companion to `ASSISTANT_ARCHITECTURE.md` (the full system design) and `COMPUTER_USE.md` (the product model). All diagrams are Mermaid, so they render on GitHub, in the Mermaid Live Editor (for a PNG/SVG export into the Google Docs), and in an artifact.

---

## 1. System Architecture (C4 model)

### Level 1 - System Context

Who uses the system and what it touches. The assistant is on-device; the only external things are the user and the apps and services it acts on.

```mermaid
C4Context
    title System Context - Off Grid AI assistant
    Person(user, "User", "Knowledge worker, on their Mac or phone")
    System(oga, "Off Grid AI", "Private on-device assistant that notices what you need and acts, with approval")
    System_Ext(apps, "The user's apps and services", "Calendar, Mail, Messages, WhatsApp, the browser, connectors")
    Rel(user, oga, "Asks in chat, approves actions")
    Rel(oga, user, "Surfaces come-ups, asks to confirm")
    Rel(oga, apps, "Acts on the user's behalf, with approval")
```

### Level 2 - Containers

The parts inside Off Grid AI and how they talk. The assistant engine is the brain; the rails are the hands; everything runs on-device.

```mermaid
C4Container
    title Container view - Off Grid AI assistant (all on-device)
    Person(user, "User", "")
    System_Boundary(oga, "Off Grid AI (on-device)") {
        Container(ui, "Approval and feed UI", "React / React Native", "Day feed, approval card, routines")
        Container(assistant, "Assistant engine", "@offgrid/use, shared TypeScript", "Reasoning, resolve, durable queue, router, gate, verify")
        Container(rails, "The rails", "DeviceController adapters, native per platform", "Semantic, browser, accessibility, vision")
        ContainerDb(memory, "Memory", "SQLite plus LanceDB", "Replay observations, entities, RAG")
        Container(model, "Local model gateway", "llama.cpp, OpenAI-compatible", "On-device LLM, grammar-constrained")
    }
    System_Ext(apps, "The user's apps and services", "Calendar, Mail, Messages, WhatsApp, web, connectors")
    Rel(user, ui, "Sees come-ups, approves")
    Rel(ui, assistant, "Proposes and approves actions")
    Rel(assistant, model, "Proposes a validated action")
    Rel(assistant, memory, "Detects patterns, resolves slots")
    Rel(assistant, rails, "execute(action)")
    Rel(rails, apps, "Deep links, EventKit, AppleScript, GUI")
```

A Level 3 (component) view of the assistant engine - intake, queue, resolver, router, gate, verify - is the component diagram in `ASSISTANT_ARCHITECTURE.md`.

---

## 2. Sequence / Swimlane

Swimlane by actor: it makes clear who is responsible at each step, and which part of the system assists the user. Example flow: the user acts on a proactive come-up ("send the deck I promised Ali"). This is the reliable path - the model only proposes, the pipeline guarantees.

```mermaid
sequenceDiagram
    actor U as User
    participant A as Assistant (brain)
    participant M as Memory
    participant G as Gate / Approval
    participant R as Rails (DeviceController)
    participant T as Target app (Mail)

    Note over A: Reasoning engine notices a commitment
    A->>U: Come-up "you promised Ali the deck"
    U->>A: "Send it"
    A->>A: Validate and enqueue a durable Action
    A->>M: Resolve "the deck" and "Ali"
    M-->>A: Q3-strategy.pptx, Ali Chherawalla (with confidence)
    A->>G: Propose (mutate) with the evidence
    G->>U: Approval card - resolved values plus evidence
    U->>G: Approve and send
    G-->>A: Approved, payload locked
    A->>R: execute(action) on the cheapest reliable rail
    R->>T: Send via Mail (semantic rail)
    T-->>R: Sent
    R-->>A: Result
    A->>A: Verify the effect (retry once if needed)
    A-->>U: "Sent to Ali" (real confirmation, not a guess)
```

The lanes are the actors: **User**, **Assistant** (brain), **Memory**, **Gate**, **Rails**, and the **target app**. For a GUI action (say a WhatsApp file share) the same lanes hold; only the rail changes to vision, and the target app is driven step by step with a pause at the send.

---

## 3. User Flows

The paths a user can take through the product, from the two entry points (the proactive Day feed, or asking in chat) through the gate to a verified result, plus the two ways a routine is born.

```mermaid
flowchart TD
    S([Open Off Grid AI]) --> DAY[Day - the Needs you feed]
    ASK([Ask in Chat]) --> REV[Review the action]

    DAY -->|reasoned come-up| REV
    DAY -->|routine proposal| TR[Turn into routine]
    DAY -->|record a routine| DEMO[Demonstrate it once]

    REV --> CARD[Approval card:<br/>resolved values + evidence + confidence]
    CARD -->|low confidence| PICK[Pick the right one]
    PICK --> CARD
    CARD -->|edit| CARD
    CARD -->|dismiss| DAY
    CARD -->|approve| EXE[Assistant runs it on a rail]

    EXE --> VER{Verified?}
    VER -->|yes| DONE([Done - toast confirms])
    VER -->|no, retry once| EXE
    VER -->|still no| HELP([Needs help - asks you])

    TR --> CONF[Confirm the learned steps<br/>and set a trigger]
    DEMO --> CONF
    CONF --> SAVE([Saved - starts as Suggest])
    SAVE -.runs on its trigger.-> REV
```

**Reading it:** two entry points - the proactive **Day** feed and **Chat**. Both land on the **approval card**, which shows the resolved values with their evidence and confidence; low confidence branches to a quick "which one did you mean" pick. Approve runs it on a rail, then **verify** decides done, retry-once, or ask you. Separately, a routine is born two ways - the assistant proposes a detected pattern, or you record one by demonstrating it - both converge on confirming the learned steps and setting a trigger, and a saved routine starts as **Suggest** (asks before each run) until you trust it.

---

## Notes for dropping these into the Google Docs

- To get a PNG or SVG for the TRD / PRD, paste any block above into https://mermaid.live and export.
- The C4 diagrams use Mermaid's native `C4Context` / `C4Container` types, so they are true C4, not a flowchart dressed up as one.
- The swimlane is a sequence diagram (each participant is a lane) - the TRD allows either; sequence is the better fit here because it shows which part of the system assists the user at each step.
