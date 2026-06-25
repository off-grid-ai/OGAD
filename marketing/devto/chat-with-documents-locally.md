---
title: How to Chat With Your Documents Locally (Offline RAG, No Cloud)
published: false
description: Upload PDFs, notes, and audio, then chat with cited sources entirely on-device. No cloud, no account, no API keys.
tags: ai, privacy, rag, llm
cover_image:
---

A modern laptop has 16GB or more of RAM and a GPU that sits at 2 percent load while you read a PDF. That hardware can run a language model and a vector search index at the same time, but most "chat with your documents" tools ship your files to a server and charge you monthly for the privilege. Off Grid AI Desktop is a free, open-source app that runs the whole pipeline, embeddings, vector store, and chat, directly on your Mac or PC.

**[GitHub](https://github.com/off-grid-ai/desktop)**

Free, open-source, runs offline.

## What this gets you

You drop a folder of contracts, meeting notes, or research papers into a project. The app reads them, builds embeddings on-device, and stores them in a local vector index. Then you ask questions in plain language and get answers with citations pointing back to the exact source.

Nothing uploads. No file leaves the machine. No account, no key, no telemetry.

## What You Need

The work splits across the model and the embedding step. Both run locally, so RAM and disk matter more than anything.

| Tier | Chip / GPU | RAM | OS | Free disk |
|---|---|---|---|---|
| Minimum | Apple Silicon M1, or any 2019+ Intel/AMD with iGPU | 8GB | macOS 13+, Windows 11 | 12GB |
| Recommended | M2/M3/M4, or NVIDIA RTX (CUDA) | 16GB+ | macOS 14+, Windows 11 | 25GB+ |

On 8GB you run a small quantized model and keep document sets modest. On 16GB and up you can load a larger model and index thousands of pages without thrashing.

## What Off Grid AI Desktop Can Do

Projects are the container. Each project holds its own documents and its own chat history, so your tax files and your novel drafts never bleed into each other.

You can upload text, Markdown, PDF, DOCX, images, audio, and video. Images go through on-device OCR so scanned receipts and screenshots become searchable text. Audio and video get transcribed locally with whisper, so a recorded lecture becomes a document you can question.

Every answer cites its sources. You see which document and which passage the model pulled from, so you can verify the claim instead of trusting it. That matters when the answer is a clause in a contract or a figure in a report.

You can also flip a toggle to include your captured memory. If you use the screen-capture feature, the model can pull from what you have read and worked on, not just the files you uploaded. The toggle is yours to turn off.

## How It Works

RAG means retrieval-augmented generation. The plain version is short.

First, the app splits each document into chunks and turns each chunk into a vector, a list of numbers that captures meaning. This is the embedding step, and it runs on-device.

Second, the vectors go into a local vector store. When you ask a question, the app embeds your question the same way, then finds the chunks whose vectors sit closest to it.

Third, those chunks get handed to the local language model as context, along with your question. The model answers using that context and points back to the chunks it used.

So the model never has to memorize your files. It reads the relevant pages at question time, which is why a 7B model on your laptop can answer questions about a 400-page document it has never seen before.

## How Hardware Acceleration Works

On a Mac, the bundled `llama.cpp` server uses Metal and Apple's unified memory. The CPU, GPU, and model share one memory pool, so a quantized model loads without copying weights back and forth. That is why an M-series laptop runs a 7B model at usable speed.

On Windows, the same engine uses CUDA on NVIDIA cards or Vulkan on others, and falls back to CPU when no GPU is available. CPU-only works for smaller models, just slower.

Models ship as quantized GGUF files. Quantization shrinks the weights, a q8_0 or Q4_K build of a 7B model fits in consumer RAM and VRAM instead of needing a data-center card. The embedding model is small by comparison and runs comfortably alongside the chat model.

## Keeping Retrieval Sharp

A few habits make local RAG noticeably better.

Keep projects focused. A project with one topic retrieves cleaner chunks than a junk drawer of every file you own. If you mix tax records, recipes, and code docs in one project, the closest-vector match gets noisier.

Name and structure your source files. The chunker works with what is on the page, so a PDF with real headings beats a wall of scanned text. Run OCR-heavy documents through and spot-check the citations.

Watch your context window. The retrieved chunks plus your question have to fit in the model's context. If answers feel truncated, lower the number of chunks retrieved or use a model with a longer context window. The chat settings expose temperature and context controls so you can tune this.

## Privacy: Stronger Than the Cloud Option

A cloud RAG product uploads your documents to a server, embeds them there, and stores the vectors on infrastructure you do not control. Even with good intentions, your contracts and notes now live somewhere else.

Off Grid AI Desktop inverts that. The documents stay on disk. The embeddings stay on disk. The chat happens on disk. There is no account to create and no telemetry phoning home. The code is AGPL-3.0, so you can read exactly what it does with your files.

For anything covered by an NDA, a privacy regulation, or just your own preference, on-device is the difference between "trust us" and "verify it yourself."

## Getting Started

1. Go to [github.com/off-grid-ai/desktop](https://github.com/off-grid-ai/desktop) and download the build for macOS or Windows, or clone and build from source.
2. Install and open the app. No sign-up screen appears, because there is no account.
3. Open the Models browser, pick a chat model that fits your RAM, and download it.
4. Create a project and drag in your documents. Let the app finish indexing.
5. Open the chat for that project and ask a question. Check the citations on the answer.

## What's Coming

- Cross-device sync, so a project indexed on your laptop is available on your other machines, still without a server in the middle.
- More embedding and chat models in the built-in browser.
- Unified search across projects and captured memory.

## FAQ

### Q: Is it really free?

Yes. The app is free and open-source under AGPL-3.0. There is no document quota and no paid tier gating the RAG feature.

### Q: Does it work fully offline?

Yes. After you download a model, you can pull the network cable. Embedding, retrieval, and chat all run locally.

### Q: Which file types can I upload?

Text, Markdown, PDF, DOCX, images, audio, and video. Images use OCR and audio/video are transcribed with whisper, so they all become searchable text.

### Q: How much RAM do I need?

8GB runs a small model and modest document sets. 16GB or more is comfortable for larger models and bigger libraries.

### Q: Does it run on both Windows and Mac?

Yes. Macs use Metal, Windows uses CUDA or Vulkan with a CPU fallback.

### Q: Is my data private?

Your files never leave the machine. No account, no telemetry, and the source is open so you can confirm it.

Download it and chat with your own documents, offline.

**[GitHub](https://github.com/off-grid-ai/desktop)**
