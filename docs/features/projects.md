# Projects (RAG)

[← All features](../FEATURES.md)

![Projects](../screenshots/03-projects.png)

- Group related chats; give a project **instructions** (a system prompt prepended to every
  chat in it).
- **Knowledge base** — upload documents (txt, md, **PDF**, DOCX), images, audio, or video.
  Audio is transcribed; video frames are read by the vision model. Everything is chunked +
  embedded locally (LanceDB) and retrieved when you chat in the project.
- **Your chats**, **Files**, and **Artifacts** for the project are all in one place.
- Retrieval in the free build spans your **uploaded documents** (captured-memory retrieval is
  a Pro feature).
