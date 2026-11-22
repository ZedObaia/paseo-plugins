Databases finds PostgreSQL connections and opens SQLite files for each Paseo workspace, using
[db-studio](https://dbstudio.sh) to browse and edit tables, inspect schemas, and run SQL.

Choose **Databases** from a workspace's **+** tab menu, or search **Explore workspace databases**
in the Command Center. Every workspace also has a **Databases** button in its header, beside
the other workspace tools. It always opens a dropdown, including when there is one connection
or none. The dropdown shows only this worktree's databases and refreshes every five seconds
while open; choose a database to launch Studio directly. Discovery errors have a retry action.
**Manage connections** opens the workspace panel for credentials, new connections, and options.
An existing studio's agent and forwarding options are preserved when opening from the header.

## Connections and discovery

The panel initially shows only **This worktree**: its project environment connections, running
containers matched to its directory, and connections saved for that workspace. **Add connection**
reveals **Available on this host**, a manual PostgreSQL URL field and a **SQLite file** option. Connecting to a shared host database
adds it to this worktree; other worktrees keep their own lists. There is no global sidebar entry.

Discovery includes:

- Project `.env.local`, `.env.development.local`, `.env.development` and `.env` files containing
  `DATABASE_URL`, `POSTGRES_URL`, `PG_URL`, or prefixed versions of those names. `PGHOST` and
  `PGDATABASE` with optional `PGPORT`, `PGUSER`, and `PGPASSWORD` are supported too. Parent
  directories are deliberately not searched: another worktree's connection must not become yours.
- Running PostgreSQL, PostGIS, pgvector and Timescale containers with published TCP ports.
  Compose working-directory labels match containers to their worktree; other containers appear
  as shared host connections. Docker initialization variables suggest credentials but may be stale
  when a persistent volume has an older password.
- PostgreSQL on localhost's standard port, plus non-standard listening ports when `lsof` is
  available. A PostgreSQL protocol probe distinguishes the server from an unrelated listener.
  Unix sockets in `/tmp` and `/var/run/postgresql` are listed too.
- Connections and SQLite file paths saved through this plugin for this workspace.

Use **Credentials** to override a detected username, password, or database, or **Add connection**
to choose a host database or enter a PostgreSQL URL. Discovery cannot recover unknown passwords. Containers need a port
published to the daemon host, preferably on `127.0.0.1`; the plugin does not change Docker networking.

To open SQLite, choose **Manage connections → Add connection → SQLite file**, then enter an existing
file path on the Paseo host, such as `./data/app.sqlite` or `/absolute/path/app.db`. Relative paths
start in this worktree; `~/` and `file:` URLs work too. The file is checked for a SQLite header,
and a missing file is never created. It is saved for this workspace and appears in its Databases
dropdown on subsequent opens. Files are not uploaded from the phone or desktop client. Studio
edits the original file and may create SQLite WAL/SHM files, so its directory must be writable.

## SQL and agents

The bundled frontend adds completion from the connected database's schemas, tables, column names,
and types, including simple table aliases. This is metadata completion, not a full PostgreSQL
language server; CTE and nested subquery scope resolution are not implemented.

**Format** uses the connected engine's SQL dialect and preserves strings and comments. The assistant
also uses the PostgreSQL or SQLite dialect. **Run** executes one statement at a time. Results retain
at most 1,000 rows and explicitly report truncation.

PostgreSQL queries time out after 30 seconds and can be cancelled. The SQL editor keeps one connection per
selected database, so `BEGIN`, `COMMIT`, `ROLLBACK` and temporary tables persist across runs.
Closing the studio disconnects those sessions and rolls back unfinished transactions.

SQLite uses upstream's runner, which rejects transaction-control statements because a transaction
cannot span separate runs. Query cancellation is unavailable; **Stop studio** ends its process.
SQLite results are capped after execution, so use `LIMIT` for large result sets. The gateway's
45-second request timeout does not cancel the underlying SQLite query.

**Ask Paseo** uses a temporary agent in a hidden background workspace sharing this worktree's
directory. It does not add an agent tab to your workspace. The drawer keeps db-studio's conversation
layout, suggestions, message composer, and **New Chat** action. Choose a model from the Paseo model
picker in the composer, or leave **Workspace default** to use the panel's optional `provider/model`
setting and then an available provider's default. Follow-up messages include up to 12 recent
conversation messages. **New Chat** clears that context. The assistant receives the schema metadata,
including column descriptions, and your request.
Database rows and credentials are not included in that prompt. Generated SQL is inserted as an
editable **AI query** draft and opened in the runner, even if the runner has never been visited;
running it is a separate action. The assistant uses the supplied schema without tools. If a provider
requests extra permissions, Studio reports an error instead of leaving a hidden agent waiting.
Temporary agents and their background workspaces are archived after completion or cancellation.

## Desktop and remote hosts

On Paseo desktop the studio opens in the built-in workspace browser. Other clients open it in an
external browser; this is a web database client, not a native mobile grid.

Both studio processes listen only on the daemon's loopback interface. For a remote daemon,
enter a local forwarded address, such as `http://localhost:4000`, in **Browser address for a
forwarded remote studio**. Launch the studio, note the host port shown in the panel, then forward it:

```bash
ssh -N -L 4000:127.0.0.1:HOST_PORT user@daemon-host
```

Choose **Reopen studio** after the tunnel is ready. An existing authenticated HTTPS reverse proxy
can also be used with its origin in that field. SSH tunnel setup is manual; the plugin never
opens a public listener or changes Paseo's connection settings.

Each workspace has its own studio process and saved-connection directory, so another workspace
cannot silently change the active connection. Selecting another connection replaces that
workspace's studio after the replacement has connected successfully. Use **Stop studio** to close
it. Archiving a workspace or stopping/reloading the plugin also closes its studios; the plugin
never stops or deletes PostgreSQL containers or their volumes.
After a restart, open **Databases** and select the database again to start a fresh session;
an older browser tab still points at the stopped studio.

## Requirements and data

- Paseo 0.12.0 or newer. On the desktop daemon, Node.js 22 or newer must be in PATH to run db-studio.
- Docker is optional; environment discovery, manual URLs and host discovery work without it.
- Connection URLs are saved in owner-only files under
  `$PASEO_HOME/plugin-data/databases` (normally `~/.paseo/plugin-data/databases`). They contain
  passwords. Removing that directory after stopping the plugin forgets its saved credentials.
- Browser sessions require a random token exchanged for an HttpOnly, SameSite cookie. Tokens are
  not database credentials. Keep a studio's launch URL private.
- Schema metadata and your generation request go to the selected Paseo agent's configured model
  provider. The bundled upstream AI proxy and telemetry are disabled. No additional API key is needed.

## Development

```bash
npm ci --ignore-scripts
npm run prepare:studio
npm run typecheck
npm test
npm run licenses:check
npm run audit:dependencies
PASEO_DATABASE_TEST_URL=postgresql://user:password@localhost:5432/paseo_test npm run test:integration
```

The integration database must be disposable and its name must start with `paseo_test`. The check
creates and removes a test table. It tests the real PostgreSQL runner and db-studio gateway.

Prebuilt frontend assets are committed so installing the plugin requires only Node/npm. Rebuilding
them requires Bun and downloads the exact upstream revision and its locked build dependencies:

```bash
npm run build:studio
```

See [upstream notes](assets/UPSTREAM.md) for the pinned source and modifications, and the
[third-party inventory](assets/THIRD-PARTY.md) for the distributed dependency licenses and notices.
Dependency overrides and a patched frontend lockfile address the known SheetJS, MSAL Node, Axios and
Zod advisories. CI checks inventory freshness and audits both the npm dependency tree and bundled
frontend versions. Mobile forwarding through Ports remains unfinished; this build targets desktop use.
