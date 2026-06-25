---
title: "Skills: Give Your Local AI Reusable, Triggerable Automations (On-Device)"
published: true
description: Package instructions into reusable skills your local AI can run on command or on a schedule. Fully on-device, no cloud, no API keys.
tags: ai, privacy, automation, productivity
cover_image: https://raw.githubusercontent.com/off-grid-ai/desktop/marketing-assets/covers/local-ai-skills-automation.jpg
---

You write the same prompt to your AI over and over. The proofread instructions. The standup format. The triage rules. Every time you retype them, or paste them from a notes file, and tweak the wording again.

Off Grid AI Desktop lets you save that prompt once as a skill, then run it with a slash command or let it fire on its own. All of it runs on your machine.

**[GitHub →](https://github.com/off-grid-ai/desktop)**

Free, open-source, runs offline. No account, no API keys, no telemetry.

## What a skill is

A skill is a reusable instruction pack. If you have used Claude Code skills, the shape is familiar. You hand the model a folder of instructions, name it, and call it up whenever you need that behavior.

Each skill is a folder under a local `.skills` directory. Inside sits a `SKILL.md` file with two parts: frontmatter that gives the skill a name and a description, and a body that holds the actual instructions.

```
.skills/
  proofread/
    SKILL.md
```

A `SKILL.md` looks like this:

```markdown
---
name: proofread
description: Fix grammar and tighten prose without changing meaning.
---

Read the text I give you. Correct spelling and grammar.
Tighten wordy sentences. Keep my voice and meaning intact.
Return the cleaned text, then a short list of what you changed.
```

If you do not need a folder, a bare `proofread.md` works too. Same idea, one file.

## Running a skill on command

Type a slash command in chat to invoke a skill. `/proofread` pulls in that skill's instructions and applies them to your message.

This is the everyday use. You build a small library of skills for the things you ask for constantly, then call them by name instead of retyping the prompt.


A few skills worth writing first:

- **proofread**: clean up grammar and tighten prose without changing your voice.
- **standup**: turn a list of yesterday's work into a tight daily standup post.
- **triage**: read a batch of messages or tasks and sort them by urgency with a one-line reason each.

Each one is a few lines of `SKILL.md`. Write them once and they are there forever.

## Triggers: skills that run on their own

A skill does not have to wait for a slash command. You can give it a trigger and it runs by itself. When a triggered skill fires, it runs an action prompt you define, and it can reach for your MCP connector tools while it works.

There are three trigger types.

**Schedule.** The skill runs daily at a local time you set, like 09:00. Good for a morning summary or an end-of-day wrap.

**Keyword.** The skill fires when a keyword shows up in a newly captured observation. If "invoice" appears in what you captured, a billing skill can wake up and act on it.

**Event.** The skill fires on a new calendar event or a new approval. Useful for prepping context before a meeting or reacting the moment something lands in your queue.


## A worked example: the daily standup

Say you want a standup summary in your hands every morning without thinking about it.

Write a `standup` skill. The body tells the model how you like your standup formatted: what you shipped, what is next, any blockers. Give it a schedule trigger at 09:00.

Each morning the skill runs its action prompt on its own. If you have connected a task tool through MCP, the skill can pull from it while it writes. The summary is ready when you sit down. You did not type a word.


## How triggers reach your tools

A triggered skill can use the MCP connectors you have set up. Connect a tool like a task tracker or a notes tool, and a running skill can read from it as part of its work.

The local model does the reasoning. The connector fetches the data. The skill ties them together with the instructions you wrote. Your triage skill can read the day's items and sort them. Your standup skill can pull yesterday's closed tasks.

The pattern is simple to hold in your head. Connectors bring data in. The on-device model reasons over it. The skill says what to do.

## Everything stays local

This is the part that separates it from cloud automation tools. The skill files live on your disk. The model that runs them is on your machine. The triggers fire on your machine.

Nothing leaves the device. Your `.skills` folder is yours to read, edit, version in git, and back up. There is no automation service watching your calendar from a server, and no prompt library sitting in someone else's account.

## Tips for writing good skills

A few things that make skills work better.

Keep the description sharp. It tells the model what the skill is for, so a vague description gets vague behavior.

Be specific in the body. Spell out the format you want, the tone, the edge cases. The model follows clear instructions far better than hints.

Start with one skill you reach for daily. Get it right, then add the next. A handful of sharp skills beats a pile of half-written ones.

For triggered skills, scope the action prompt tightly. A skill that runs on its own should know exactly what to produce, since you will not be there to nudge it.

## Privacy: stronger than cloud automation

Cloud automation platforms hold your triggers, your prompts, and the data they touch on their servers. Every run is logged somewhere you do not control.

Off Grid AI Desktop holds all of it on your machine. The skill files are local. The model is local. The triggers run local. The app is AGPL-3.0, so you can read exactly what it does. No account, no telemetry.

## Getting started

1. Get the app from https://github.com/off-grid-ai/desktop, or clone and build it.
2. Install and launch it, then download a chat model from the built-in browser.
3. Create a `.skills` folder and drop in a `proofread.md` or a `proofread/SKILL.md`.
4. Type `/proofread` in chat to run it.
5. Add a trigger to a skill to have it run on a schedule, on a keyword, or on an event.


## What's coming

- A richer trigger set for more events around capture and approvals.
- Sharing skill folders across your paired devices over the mesh.
- A library of starter skills to fork and edit.

## FAQ

### Q: Is it really free?
Yes. The app is free and open-source under AGPL-3.0. No account, no subscription, no API keys.

### Q: How is a skill different from just pasting a prompt?
A skill is saved, named, and callable with a slash command. You write it once instead of retyping the prompt every time, and a skill can also run on its own with a trigger.

### Q: Do skills work offline?
Yes. Skills are files on your disk and the model runs on your machine. The network is not needed.

### Q: What can trigger a skill automatically?
A daily schedule at a local time, a keyword in a newly captured observation, or an event such as a new calendar entry or a new approval.

### Q: Can a skill use my connected tools?
Yes. A triggered skill can use your MCP connector tools while it runs its action prompt.

### Q: Is my data private?
Yes. Skill files, the model, and triggers all stay on your machine. There is no telemetry and the source is open.

Save your prompts as skills and let your local AI run them for you.

**[GitHub →](https://github.com/off-grid-ai/desktop)**
