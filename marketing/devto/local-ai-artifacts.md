---
title: "Local Artifacts: Render HTML, React, SVG, and Mermaid On-Device (No Cloud)"
published: true
description: Ask your local AI for a chart, a diagram, or a mini-app and watch it render live in a sandboxed iframe. Fully on-device, no cloud, no CDN.
tags: ai, privacy, react, opensource
cover_image: https://raw.githubusercontent.com/off-grid-ai/desktop/marketing-assets/covers/local-ai-artifacts.jpg
---

Your browser engine can run React, render SVG, and draw a Mermaid diagram with no internet at all. The runtimes are just JavaScript files. Yet most AI artifact features ship your prompt to a server and render the result in their cloud, on their terms.

Off Grid AI Desktop has a canvas that renders the model's output live on your machine, in a sandbox that cannot reach the network.

**[GitHub →](https://github.com/off-grid-ai/desktop)**

Free, open-source, runs offline. No account, no API keys, no telemetry.

## What it does

When the local model writes a block of HTML, SVG, Mermaid, or React (JSX), Off Grid AI Desktop renders it live. The code does not just sit in the chat as text. It runs, and you see the result next to it.

If you have used the artifacts feature in a cloud chat tool, you know the feel. Ask for a dashboard, get a working dashboard. Ask for a flowchart, get a flowchart. The difference here is where it runs. Everything happens in the app, on your hardware.


## What you need

The canvas is light. The model that writes the code is the heavy part.

**Minimum:** any Apple Silicon Mac (M1 or later) or a Windows PC with 8 GB RAM and a recent CPU.

**Recommended:** 16 GB RAM and a chat model good at code. A stronger code model writes cleaner components and fewer broken renders.

The rendering itself uses your browser engine, which every machine already has.

## The four block types

The canvas knows four kinds of output.

**HTML** renders a page or a fragment, styles and all. Good for landing pages, formatted layouts, and quick mockups.

**SVG** draws vector graphics. Logos, icons, simple illustrations, hand-rolled charts.

**Mermaid** turns text into diagrams. Flowcharts, sequence diagrams, org charts, state machines. You describe the shape in words and it draws.

**React (JSX)** runs real components. Interactive widgets, small tools, anything with state and buttons.


## The sandbox: no network, no files

The render happens inside a sandboxed iframe. That sandbox has no network access and no file access. The code the model writes cannot phone home, cannot read your disk, and cannot reach anything outside its own frame.

This matters because AI-written code is still code you did not review line by line. Running it in a sealed box means a stray fetch or a sketchy script has nowhere to go. You get the rendered result without handing the model the keys to your machine.

## No CDN, no internet

Browser-based React tools usually pull React, a JSX compiler, and a diagram library from a CDN at runtime. That means a network call every time, and it means nothing renders when you are offline.

Off Grid AI Desktop bundles those runtimes in the app's own resources. React (UMD), Babel-standalone for JSX, and Mermaid all ship inside the app. The canvas loads them locally. No CDN, no internet, no waiting on someone else's server to be up.

Turn off your network and the canvas still renders everything.

## Code and Preview, plus download

Each artifact has a Code and Preview toggle. Flip to Preview to see the running result. Flip to Code to read what the model actually wrote and check it before you trust it.

When you like what you see, download it. The artifact is a real file you can drop into a project, open in a browser, or hand to someone else.


## What people build with it

A few things the canvas is good for.

**Dashboards.** Ask for a metrics view with cards and a layout, get a working HTML or React dashboard you can fill with your own numbers.

**Charts.** Describe the data and the chart type. Get an SVG or a React chart rendered on the spot.

**Diagrams.** Explain a flow or a system in plain words. Mermaid draws it. Edit the description and it redraws.

**Mini-apps.** A unit converter, a timer, a small calculator. React components with real interaction, running in the sandbox.

**Landing pages.** Sketch a hero, some sections, a call to action. HTML renders it live so you can see the page take shape.

## Tips for cleaner renders

A few things help.

Pick a model that is strong at code. Component output is only as good as the model writing it, and a code-tuned model breaks less often.

Be specific about what you want. Name the chart type, the layout, the colors. Vague prompts get vague components.

Use the Code view to catch problems. If a render looks off, read the code. Often it is one obvious fix you can ask the model to make.

For React, ask for a single self-contained component. Fewer moving parts means fewer broken renders in the sandbox.

## Privacy: stronger than cloud artifacts

Cloud artifact features send your prompt to a server, render in their environment, and keep a copy. Your dashboards, your diagrams, your half-formed ideas all pass through infrastructure you do not control.

Off Grid AI Desktop keeps it on your machine. The model runs locally. The runtimes are bundled, not fetched. The sandbox has no network out. The app is AGPL-3.0, so you can read the source and confirm all of it. No account, no telemetry.

## Getting started

1. Grab the app from https://github.com/off-grid-ai/desktop, or clone and build it.
2. Install and launch it.
3. Download a chat model from the built-in browser, ideally one good at code.
4. Ask the model for a chart, a diagram, or a small component.
5. Watch it render in the canvas, toggle to Code to check it, and download it.


## What's coming

- More renderable block types and richer diagram support.
- Editing an artifact in place and re-rendering on the fly.
- Saving artifacts into projects alongside your documents.

## FAQ

### Q: Is it really free?
Yes. The app is free and open-source under AGPL-3.0. No account, no subscription, no API keys.

### Q: Does the canvas work offline?
Yes. The React, Babel, and Mermaid runtimes are bundled in the app. There is no CDN call, so it renders with the network off.

### Q: Is it safe to run AI-written code?
The render happens in a sandboxed iframe with no network and no file access. The code cannot reach your disk or the internet. You can also read it in the Code view first.

### Q: What can it render?
HTML, SVG, Mermaid diagrams, and React (JSX) components. Dashboards, charts, diagrams, mini-apps, and landing pages.

### Q: Can I export what it makes?
Yes. Each artifact has a download, so you get a real file to use elsewhere.

### Q: Is my data private?
Yes. The model runs locally, the runtimes are bundled, and the sandbox has no network out. There is no telemetry and the source is open.

Ask for a chart, a diagram, or a mini-app and watch it render on your own machine.

**[GitHub →](https://github.com/off-grid-ai/desktop)**
