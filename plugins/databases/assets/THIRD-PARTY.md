# Third-party inventory

[THIRD-PARTY-INVENTORY.json](THIRD-PARTY-INVENTORY.json) lists names, versions, license identifiers,
distribution scopes, package archive integrity values and notice hashes.
[THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt) contains the corresponding license and attribution texts.
Keep both files with this plugin. The plugin's original code remains under the repository's MIT license.

## Coverage

- Every production package in the plugin's npm lockfile, including optional native packages for
  platforms other than the machine generating the inventory. Missing platform packages are fetched
  from their locked archives and checked against the lockfile's integrity value before extraction.
- The dependencies in the patched frontend's Vite license report, plus JetBrains Mono, Tailwind CSS
  and tw-animate-css, whose generated CSS/font assets are not included in Vite's JavaScript report.
- Package-provided LICENSE, COPYING, NOTICE, copyright, authors and third-party notice files,
  including Monaco's ThirdPartyNotices.txt. Fonts retain their OFL text and copyright notice.
- db-studio's Apache-2.0 license and AUTHORS, and additional attribution for the shadcn/ui,
  AI Elements and Kibo UI registries used by the pinned upstream source. Registry component revisions
  were not recorded by upstream; these entries identify the db-studio revision carrying that code.
  Kibo's notice is retained conservatively because upstream registers that component source.

This inventories the distributed npm packages and bundled frontend, including package-provided
native-code notices. It does not inventory the operating system, Node.js, the Paseo host, external
database servers, or tools used only to build the plugin.

The unused frontend inside the `db-studio` npm package is removed by `npm run prepare:studio` during
plugin installation. Only Paseo's patched frontend is served. This also removes the unused bundle's
older Axios and Zod copies.

## Reviewed supplements

Some packages omit license files from their published archives. The version-specific mappings in
[license-supplements/manifest.json](license-supplements/manifest.json) retain the recovered texts and
their upstream source URLs. Most URLs identify immutable repository commits.

- libSQL, Radix, Sentry, React JSON View and react-remove-scroll-bar retain their upstream license texts.
  react-remove-scroll-bar's published gitHead is unavailable in its public repository, so its MIT text
  is retained from the recorded repository commit instead.
- PostHog's `SEE LICENSE IN LICENSE` declaration is resolved to Apache-2.0 after reviewing its actual
  package license, including the PostHog and Mixpanel copyright notices.
- promise-limit declares ISC but supplies no standalone license text or copyright header in its
  published archive or release source. Its declared author is retained with the ISC grant and
  disclaimer from the SPDX standard text; no copyright year or owner has been invented.
- railroad-diagrams declares CC0-1.0. The inventory retains its author and the full CC0 legal text.
- react-icons' package license lists many icon sets. The pinned app imports only `react-icons/lu`;
  those glyphs are covered by the retained Lucide license. Other icon sets in that table are not
  bundled by this app.

## Regeneration and checks

```bash
npm ci --ignore-scripts
npm run prepare:studio
npm run build:studio
npm run licenses:check
npm run audit:dependencies
```

`build:studio` applies the pinned source and dependency patches, installs the patched frozen Bun
lockfile, validates TypeScript, builds the frontend and regenerates both inventories. Bun is only
needed for this maintainer step. The Vite wrapper emits license metadata; the frontend also serves
the complete frontend attribution records at `/third-party-licenses.json` within an authenticated session.

After a backend-only dependency update, `npm run licenses` refreshes the combined inventory without
rebuilding the frontend. `licenses:check` verifies the lockfile and frontend coverage, source/build
fingerprints, supplemental texts and the notice file hash. Missing license identifiers or texts fail generation.
CI runs this check and audits both the npm tree and the actual bundled frontend versions.

The dependency pins address the known SheetJS, MSAL Node, Axios and Zod advisories with SheetJS
0.20.3, MSAL Node 7.1.0, Axios 1.20.0 and Zod 4.6.6. SheetJS is installed from its
[official distribution](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/), since npm's
`xlsx` release is older. The package lockfile records the tarball integrity value.
