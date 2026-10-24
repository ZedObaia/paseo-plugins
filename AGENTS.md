# Agents

Notes for agents working in this repository. How plugins are laid out, built and tested is in
[README.md](README.md).

## Listing a plugin on paseo.sh/plugins

The directory is the [getpaseo/plugins](https://github.com/getpaseo/plugins) repository. A review
bot there follows its `REVIEW.md` (read it from `main`) and the
[publishing guide](https://paseo.sh/docs/plugins/publishing). Listed so far, under `zedobaia/`:
Resources, Devices, Ports and Linear.

### Before submitting

1. Checks pass: `npm run typecheck && npm test` in the plugin, and `npx prettier@3.6.2 --check .`
   at the root.
2. `paseo-plugin.json` has a one-sentence `description`, an `icon` (`assets/icon.png`, 256 px, a
   white glyph on a gradient square like the others) and `media`: the listing slides, hero first,
   since the first image is the card thumbnail.
3. `OVERVIEW.md` beside the manifest is the listing page, in the guide's order: what the plugin
   does, how it works, setup (accounts, tokens, the Paseo version, which apps), then capabilities,
   data access and where data goes (including what reaches agents' model providers), permissions
   and limits. No install commands: the validator rejects `paseo plugin add` and `npm install`.
4. The slides are 1800x1125 PNGs in `assets/`: a hero with the pitch, the plugin in the app, one
   or two features, and the phone layout. They show the real UI with sample data that names no real
   account, project, host or tailnet. One way that touches nothing of yours:
   - Run a second daemon, `paseo daemon run --home <tmp>`, whose `config.json` listens on another
     port and allows the page's origin in `daemon.cors.allowedOrigins`. Install a copy of the plugin
     into it, add sample projects and workspaces with `paseo project create` and
     `paseo workspace create`, and point anything external at a local mock.
   - Serve `/Applications/Paseo.app/Contents/Resources/app-dist` on that origin, connect to the
     daemon, choose the dark theme and rename the host, then capture at 2x (desktop 1280x800,
     phone 390x844 at 3x).
   - Lay the captures out with the headline and text in HTML at 1800x1125, screenshot them, and
     delete the daemon's home afterwards.
5. It installs from a copy without `node_modules`, the way Paseo builds a listed plugin: copy the
   plugin folder to a temporary directory, delete `node_modules` there, and
   `paseo plugin install <dir> --id <id>-check` (remove it afterwards). Only Paseo's own modules
   resolve then (`@getpaseo/plugin`, `zod`, `react`, `react-native`, `@tanstack/react-query`), so
   even a type-only import from anything else, like `@getpaseo/client`, fails the build: derive
   such types from `@getpaseo/plugin/server` instead. Linear 0.1.0 was listed broken this way.
   A directory install doesn't run the manifest's `build` (daemon 0.12.0), so for a plugin with
   dependencies, like Devices, run that command in the copy before installing it. To leave the
   live plugin alone (Devices keeps its state and sockets under `plugin-data/devices` whatever
   its ID), install it into a second daemon as in step 4.
6. The commit to submit is pushed to `main`.

### Submitting

Through the web form only:
<https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml>. The form adds the
`submission` label that starts intake; we can't set labels on that repository, so an issue opened
with `gh issue create` is never picked up. The user submits it in their browser.

- Title: the plugin's name.
- Source: the plugin's folder at the pushed commit,
  `https://github.com/ZedObaia/paseo-plugins/tree/<commit>/plugins/<id>`.
- Categories: tick what fits; the first tick is the main one.

A link with the title and source filled in saves typing; the categories still need ticking:
`https://github.com/getpaseo/plugins/issues/new?template=submit-plugin.yml&title=<Name>&source=<url-encoded source>`

### After

- A bot comments on the issue with the review PR. The review bot inspects the plugin without running
  it, may edit the registry record and listing itself, then approves and merges and says so on the
  issue. If it needs something, it says exactly what on the PR; answer there.
- Updates aren't picked up by themselves: submit the form again with the new commit's folder URL,
  as Ports 0.2.0 did (issue #664). Bump the plugin's `package.json` version first.
- Once a plugin is listed, the README can install it as `zedobaia/<id>` instead of from Git.
- Switching a host from a local or Git install to the listed one: `paseo plugin remove <id>`
  deletes `plugin-settings/<id>` under Paseo's home (`plugin-data` stays), so copy the settings
  first and put them back after `paseo plugin add zedobaia/<id>`.
