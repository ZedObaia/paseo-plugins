# paseo-plugins

Paseo plugins, one per directory under `plugins/`.

| Plugin | What it does |
| --- | --- |
| [resources](plugins/resources) | Host CPU, memory, disks, top processes and Docker usage, with cleanup actions |

Install on a host (needs `pluginsEnabled` in that daemon's config):

```bash
paseo plugin add git:ZedObaia/paseo-plugins:plugins/resources
paseo plugin update resources   # later
```

Develop: `cd plugins/<name> && npm install && npm run typecheck`, then
`paseo plugin install $PWD` once and `paseo plugin reload <name>` after each change.
