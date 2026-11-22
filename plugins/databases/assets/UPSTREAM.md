The compressed `studio.json.gz` contains the web frontend of
[husamql3/db-studio](https://github.com/husamql3/db-studio), version 1.20.0,
commit `48e80fface43d5b0b8145e5296fab6103ca99cd0`, under the accompanying Apache-2.0 license.

Changes made for Paseo:

- SQL formatting delegates to the local formatter using PostgreSQL or SQLite syntax.
- Monaco completion reads live PostgreSQL or SQLite schema metadata and simple aliases.
- The assistant keeps db-studio's drawer, conversation components, suggestions, composer and New Chat
  action, with Paseo background agents handling generation. The composer lists the Paseo host's models;
  follow-up requests include recent conversation context. Upstream key and quota indicators are removed.
- The assistant loads with the app instead of fetching another module when it opens.
- Failed module loads explain how to reopen an expired Studio session from Paseo.
- Assistant drafts use the saved-query store and open in the runner without requiring an existing
  editor. Formatting is wired to the current editor.
- PostgreSQL query cancellation and result-limit notices are exposed in the query runner.
  SQLite uses the upstream runner with result truncation; its Cancel control is hidden.

Each modified upstream source file carries a Paseo modification notice. The upstream source
contains no root NOTICE file. See the [third-party inventory](THIRD-PARTY.md) for dependency licenses,
attributions, supplemental source texts and regeneration instructions.

`server/build-studio.mjs` downloads the pinned source, applies `server/studio.patch`, replaces the
assistant with `server/assistant.tsx.txt`, builds the frontend with the patched frozen lockfile, and
packages the assets. `server/studio-dependencies.patch` pins patched Axios and Zod versions;
`server/studio-vite.config.ts.txt` emits license records and references them from compiled chunks.
The upstream server code is the pinned `db-studio` npm dependency, with patched SheetJS and MSAL Node
dependency overrides. Its unused original web bundle is removed during installation.
It runs behind the plugin's session gateway. These modifications are provided under this
repository's MIT license, alongside the upstream Apache-2.0 code and required notices.
