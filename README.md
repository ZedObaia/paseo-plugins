# paseo-plugins

Plugins for [Paseo](https://paseo.sh), one per directory under `plugins/`.

| Plugin                                                         | What it does                                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [Resources](plugins/resources/OVERVIEW.md)                     | CPU, memory, disk, processes and Docker usage of each Paseo host, with cleanup actions                     |
| [Devices](plugins/devices/OVERVIEW.md)                         | iOS simulators and Android emulators per workspace: live view, input, and tools for agents                 |
| [Projects everywhere](plugins/projects-everywhere/OVERVIEW.md) | Which projects each host has, and adding a project to several hosts at once, cloning it where it's missing |
| [Ports](plugins/ports/OVERVIEW.md)                             | Each workspace's open ports, with links to open them and private or public sharing                         |
| [Auto fetch](plugins/auto-fetch/OVERVIEW.md)                   | A new project's existing worktrees as workspaces, background fetching, and fast-forwarded local branches   |
| [Linear](plugins/linear/OVERVIEW.md)                           | Linear issues from several accounts, a board per project, and agents started on issues with Linear's tools |

## Install

Turn on **Settings → Plugins → Enable plugins** on the host, then:

```bash
paseo plugin add zedobaia/resources                                    # from the Paseo registry
paseo plugin add git:ZedObaia/paseo-plugins:plugins/devices
paseo plugin add git:ZedObaia/paseo-plugins:plugins/projects-everywhere
paseo plugin add git:ZedObaia/paseo-plugins:plugins/ports
paseo plugin add git:ZedObaia/paseo-plugins:plugins/auto-fetch
paseo plugin add git:ZedObaia/paseo-plugins:plugins/linear
```

Each plugin runs on the daemon you install it into, so install Resources on every host you want to
watch, Devices on the Mac (or Android SDK host) that runs your simulators, Projects everywhere on
the hosts you use, Ports on the hosts whose workspaces run servers, Auto fetch on the hosts whose
worktrees you want in Paseo and kept fetched, and Linear on the hosts whose projects you link to
Linear. Update with `paseo plugin update <id>`.

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
