/**
 * Runtime connection patch: makes the DSH client treat a LAN-served page like
 * the local page. Applied from the plugin's apply, which injects 'connection',
 * so the `isLoopback` widening is in place BEFORE ui-settings reads
 * `remote.$host.isLoopback` for the settingsScope persistence decision.
 *
 * Why this matters: on a non-loopback origin the client settingsScope would
 * otherwise resolve to `persistence: 'memory'`, which makes every settings
 * surface (Models provider directory, Plugins config cards, Language and
 * Appearance rows) render nothing — the pre-patch behavior this plugin is here
 * to override.
 *
 * Why the settings/credentials RPC routing is gone: an earlier DSH harness had
 * no way to reach the loopback-pinned configuration plane from a trusted LAN
 * authority, so this patch rerouted `api.settings.*` / `api.credentials.*`
 * through the plugin's fenced `/lan-access/rpc` proxy. The current harness's
 * `/api` gateway stops pinning those namespaces to loopback: the served LAN
 * authority is trusted (the Host/Origin fence admits it) and the ordinary
 * browser-session auth authenticates it, so the surfaces reach the host
 * directly. The `connection.handle` also no longer carries an `api` member —
 * it exposes `rpc.call('/api', …)` for every remote method — so the old
 * `connection.api.*` patch threw and aborted the widening. With the widening
 * applied first and early, the surfaces work through `/api` with no proxy hop.
 */

/** The connection handle slice this patch touches. */
export interface LanAccessConnectionHandle {
  isLoopback: boolean
}

/**
 * Whether a WHATWG hostname is a served (non-loopback) authority. This is the
 * client-side twin of the server's browser-trust fence: the page only runs
 * this code because the DSH webserver itself served it, and the server fence
 * refuses unknown Hosts — so any non-loopback hostname that served this page
 * (an IPv4 LAN literal, a DNS name, a Tailscale name, ...) is a served
 * authority. Covers plain-HTTP LAN access and HTTPS via a reverse proxy
 * (IP or hostname).
 */
function isServedLanHostname(hostname: string): boolean {
  if (hostname === '' || hostname === 'localhost' || hostname === '[::1]') return false
  const parts = hostname.split('.')
  if (parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return parts[0] !== '127'
  }
  return true
}

/**
 * Widen `connection.isLoopback` to "loopback OR served LAN authority", so
 * settingsScope-bound surfaces use host persistence on LAN pages.
 * @param connection - the ctx.connection handle (patched in place).
 * @returns the disposer restoring every patched member (HMR-safe).
 */
export function installConnectionPatch(connection: LanAccessConnectionHandle): () => void {
  const restorers: Array<() => void> = []

  // Skip fixture mode (test pages) — the fixture api must stay untouched.
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('fixture')) {
    return () => {}
  }

  const originalIsLoopback = connection.isLoopback
  // Diagnostics marker: lets the /lan-access/diag report verify the patch ran.
  try {
    Object.defineProperty(connection, '__lanAccessPatched', {
      configurable: true,
      writable: true,
      value: true,
    })
  } catch { /* non-fatal */ }
  try {
    Object.defineProperty(connection, 'isLoopback', {
      configurable: true,
      get: (): boolean => originalIsLoopback
        || (typeof location !== 'undefined' && isServedLanHostname(location.hostname)),
    })
    restorers.push(() => {
      Object.defineProperty(connection, 'isLoopback', {
        configurable: true,
        writable: true,
        value: originalIsLoopback,
      })
    })
  } catch {
    // Non-fatal: without the classification, settings surfaces stay in
    // memory mode on LAN pages (the pre-patch behavior).
  }

  return () => {
    for (const restore of restorers) {
      try { restore() } catch { /* ignore */ }
    }
  }
}
