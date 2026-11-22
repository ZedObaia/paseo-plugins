# Upstream

Fork of [oliexe/paseo-bots](https://github.com/oliexe/paseo-bots) (MIT) at
`ae406719e8ca22f7d49f377150b8de04e7f1d2f0` (0.3.1, 2026-11-16), taken from the devbox checkout with
its local changes: `server/hub-bridge.ts` and its test (GitHub comment relay), plus small edits to
`index.server.ts` and `server/tools/bots.ts`.

To take upstream changes: diff upstream between that commit and its new head, and apply the diff
here. Our own additions live in new files where possible, so the diff applies cleanly.

Renamed to plugin id `fawzy` ("Fawzy") so it installs next to the original instead of over it. The
data folder stays `plugin-data/paseo-bots` (fixed in `server/bot-home.ts`), so memory, the Hub relay
folder and run records carry over as they are. Settings are kept per plugin id: on install, copy
`~/.paseo/plugin-settings/paseo-bots/bots.json` to `~/.paseo/plugin-settings/fawzy/bots.json`, then
disable `paseo-bots`.
