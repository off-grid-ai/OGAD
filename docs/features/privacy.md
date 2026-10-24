# Privacy & data

[← All features](../FEATURES.md)

- **100% local inference.** Your conversations, documents, and models never leave the device.
- **Encryption at rest** — new databases are encrypted (SQLCipher via
  `better-sqlite3-multiple-ciphers`), with the key held by the OS keychain.
- **No account, no API key**, and it works fully **offline**.
- **Opt-in analytics.** Off by default. If you turn on usage data or crash reports (in setup,
  a prompt, or Settings > Analytics), anonymous events go to PostHog Cloud EU. Prompts, replies,
  file names, paths, URLs and search terms are never sent. See [ANALYTICS.md](../ANALYTICS.md).
