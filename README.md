# dsh-lan-access

A DeepSeek Harness web plugin that adds a **LAN access** toggle to the DSH
Settings shell (Settings → General). It replaces the manual `cordis.patch.yml`
webserver override:

> **Tested with [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `v0.1.5-alpha.1`** — this plugin is verified runnable against that harness version.

- **On** — the web GUI binds `0.0.0.0`, so other machines on the same network
  can open it at `http://<LAN-IP>:3080/?token=…`. `dsh web` prints the full
  URL (with the per-process `?token=` launch token) for the LAN address when
  it starts — a fresh LAN browser needs that token in the URL to authenticate.
  The /api trust fence is updated live, so the browser on a LAN machine works
  fully (chat, tools, workspace).
- **Off** — the GUI binds `127.0.0.1` again (loopback only — the safe default).

## Screenshots

The DSH web GUI opened from another machine on the same network
(`http://192.168.0.101:3080`):

![DSH web GUI opened over LAN](assets/lan-access-gui.png)

The **LAN access** toggle in Settings → General, showing the address other
devices can open:

![Settings → General LAN access toggle](assets/lan-access-settings.png)

## How it works

| Half | File | Role |
| --- | --- | --- |
| Host | `src/index.ts` | Registers the persisted `lan-access` settings namespace, the fenced `/lan-access` JSON route (GET state / POST set), the bind controller, and the `lanAccess` bind-host service. The webserver row's composed `host` expression reads that service, so every webserver (re)start — boot, toggle, or a post-boot user-patch re-apply — converges to the persisted setting; the controller only restarts the row when the bind actually differs. |
| Client | `src/client/` | Registers the General-settings row (`settings.general.item`, order 15) with a native checkbox switch, the LAN URLs (primary first, all live NIC addresses shown, copy button), zh/en copy, and restart-tolerant polling. |

The route fence accepts loopback or the deployment's trusted authorities, read
live from the connection row's resolved config — the same boundary the /api
gateway uses. Cross-site requests are refused.

## Install from GitHub

The built artifacts (`lib/`) are committed, so installation needs no build
step and no modification of the DeepSeek Harness checkout:

```sh
# From GitHub (replace <owner>/<repo>)
dsh plugin --profile web add git+https://github.com/<owner>/<repo>.git

# ...or clone and install the local checkout (link: keeps your rebuilds live)
git clone https://github.com/<owner>/<repo>.git
dsh plugin --profile web add link:/path/to/dsh-lan-access

# Restart the GUI
dsh web
```

The install appends `dsh-lan-access` to `dsh.profile.bundles`; its
`dsh.bundle.patch` inserts the host row and overrides the webserver row's
`host` with the `lanAccess` service expression. The client half is picked up
by the client-modules scanner automatically. **No harness change is required
for the core feature** — the toggle, the LAN bind, and the live /api trust
fence all ship inside the plugin.

> **Local development** — rebuild with `pnpm build` (or `npm run build`)
> after changing `src/`, then reinstall/restart. The repo's `node_modules`
> mirrors the DSH profile's package farm (TypeScript/tsdown come from the
> harness checkout).

> **Migrating from a manual patch** — remove any `webserver` `host: 0.0.0.0`
> override from the profile's `cordis.patch.yml` (and the bundle patch layers)
> so the plugin is the single owner of the bind host.

## Use

1. Open the GUI, go to **Settings** (sidebar footer) → **General**.
2. Flip **局域网访问 / LAN access**.
   - Enabling shows the ONE address other devices can open — the IPv4 of the
     interface that owns the default route (`http://192.168.x.x:3080`) —
     with a copy button.
   - That address must include the browser-session `?token=…` when opened
     from another machine. `dsh web` prints the full URL (with the token)
     for both the loopback and the LAN address on startup — copy the LAN one,
     e.g. `http://192.168.0.101:3080/?token=ICKD2317KYP…`. The token is a
     per-process launch token that exchanges for a session cookie; a fresh LAN
     browser cannot authenticate without it.
   - The web server restarts to rebind; the row waits for it and re-reads the
     state (a network error mid-restart is not reported as failure).
   - The plugin also installs a `crypto.randomUUID` polyfill on plain-HTTP
     LAN origins (that Web API only exists in secure contexts, and the DSH
     API client mints every RPC id with it — without the polyfill a remote
     browser fails with "crypto.randomUUID is not a function").
3. The choice is persisted in `~/.dsh/settings.yaml`:

   ```yaml
   lan-access:
     enabled: true
   ```

## Remote Settings pages and workspace — no harness change needed

Everything the plugin serves works from a LAN browser with **zero
modification of the DSH checkout**:

- **The current `/api` gateway trusts the served LAN authority**, so the
  configuration plane (`settings.*`, `credentials.*`) reaches the host
  directly — the Host/Origin fence admits the LAN host and the ordinary
  browser-session auth authenticates it. The Models page provider directory,
  the Plugins configuration cards, and the Language/Appearance rows therefore
  work remotely with no extra hop.
- **The client `settingsScope` degrades to memory mode on non-loopback
  origins** (surfaces render empty). The browser bundle widens
  `connection.isLoopback` to "loopback OR served LAN authority" at runtime.
  The client entry injects `connection` and is marked
  `dsh.client.immediately`, so its bundle is prefetched and its `apply`
  runs right after the connection row provides the handle — before any
  settings surface (which waits on `remote` / `settingsScope`) reads
  `remote.$host.isLoopback`. That `inject`-ordered widening is what keeps
  the scope in host mode on a LAN page: without it, a surface that binds early
  sees the unpatched `isLoopback` and its scope stays memory-mode — the
  plugin configuration cards render nothing.
- **`crypto.randomUUID` does not exist on plain-HTTP LAN origins.** The
  bundle installs a `getRandomValues`-based polyfill (same CSPRNG).

### Harness API changes this plugin tracks

The harness evolved the settings/connection APIs between `0.1.0-rc.5` and
`0.1.5-alpha.1`; the plugin was updated accordingly:

- `@deepseek-ai/dsh-settings` dropped the `settingsNamespace(ns)` helper —
  `settings.register` / `.update` / `.replace` / `.mutate` now take the raw
  namespace string (validated at runtime and by a compile-time guard).
- The client `ConnectionHandle` no longer carries an `api` member — remote
  methods go through `connection.rpc.call('/api', '<ns>/<method>', …)` — so
  the plugin no longer patches `connection.api.settings.*` /
  `connection.api.credentials.*`.
- The `/api` gateway stopped pinning the configuration plane to loopback: it
  now trusts the served LAN authority, so the settings/credentials RPCs reach
  the host directly. The plugin therefore widens `connection.isLoopback` early
  (via `inject: ['connection']` plus a synchronous patch) to keep
  `settingsScope` in host mode on a LAN page; the fenced `/lan-access/rpc`
  proxy is no longer required for the remote Settings surfaces.

Remaining loopback-only (hardcoded in the harness, not patchable from a
plugin): `host.pickDirectory` / `host.openPath` (native dialogs and host
file opens) and `llm.discoverModels` (the Models page "discover" button).
The workspace's own add/browse flow does not need them, and chat file
opens route into the sidebar editor.

## Debug aids

The host exposes `GET /lan-access/diag` (fenced like the other routes) with
the latest browser boot reports: slot-registration counts, whether the
connection patch is active, and a `settingsScope` probe bound to the
`shell` namespace (status `ready` proves the host-mode settings read works
end to end). During the first minute after boot the browser also posts a
2-second poll of the Plugins cards' own injected snapshots (`available`
flags), the slot ledger view, and the declared spec — the exact data that
separates "cards gone", "cards abdicated", and "cards present but rendering
null" when a Settings page misbehaves on a remote machine.

## Optional: dsh-better-sidebar compatibility patch

dsh-better-sidebar's trust fence matched the connection row by the wrong
name and read the raw `!!js` config, so its panels (explorer / editor /
terminal / git) only ever accepted loopback. The repo ships the fix as a
profile-level pnpm patch (no harness change):

```sh
./scripts/install-patches.sh web
```

This copies `patches/dsh-better-sidebar.patch` into the profile's
`patches/` directory, registers it under `patchedDependencies` in
`pnpm-workspace.yaml`, and runs `pnpm install`.

## Security notes

- Default is **off** (loopback). The DSH launcher itself refuses
  `--host 0.0.0.0` for the same reason: binding all interfaces exposes the
  agent's tools to the network. Only enable it on a trusted network.
- The toggle is only reachable through the fenced route, and disabling from a
  remote machine cuts that machine off (expected — re-enable locally).
- The bind survives plugin reloads and patch re-applies; a full process
  restart re-applies the persisted value at boot.

## Development

```sh
pnpm build        # tsdown: lib/index.js (host) + lib/client.js (browser bundle)
pnpm typecheck    # tsc --noEmit
```

The client bundle is a `__ModuleLoader__.load` closure-factory artifact (same
format as the DSH monorepo's tsdown client preset); only the frozen
platform-module table words stay external. After changing client code, rebuild
and restart `dsh web` (the client-modules package metadata cache expires only
on restart).