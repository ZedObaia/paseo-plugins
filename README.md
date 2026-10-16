# paseo-plugins

Plugins for [Paseo](https://paseo.sh), one per directory under `plugins/`.

| Plugin                                     | What it does                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| [Resources](plugins/resources/OVERVIEW.md) | CPU, memory, disk, processes and Docker usage of each Paseo host, with cleanup actions     |
| [Devices](plugins/devices/OVERVIEW.md)     | iOS simulators and Android emulators per workspace: live view, input, and tools for agents |

## Install

Turn on **Settings → Plugins → Enable plugins** on the host, then:

```bash
paseo plugin add git:ZedObaia/paseo-plugins:plugins/resources
paseo plugin add git:ZedObaia/paseo-plugins:plugins/devices
```

Each plugin runs on the daemon you install it into, so install Resources on every host you want to
watch, and Devices on the Mac (or Android SDK host) that runs your simulators. Update with
`paseo plugin update <id>`.

## Develop

```bash
cd plugins/<id>
npm install
npm run typecheck && npm test
paseo plugin install "$PWD"     # once
paseo plugin reload <id>        # after each change
npx prettier@3.6.2 --write .    # from the repo root, before committing
```

Client code (`index.client.tsx`, `client/`) runs in the Paseo app on desktop, web and phones, so it
uses React Native primitives and takes colors from the theme. Server code (`index.server.ts`,
`server/`) runs in a Node subprocess on the daemon host. `shared/` holds the RPC contracts both use.

## License

[MIT](LICENSE)
