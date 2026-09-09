/**
 * dsh-lan-access host half: owns the web GUI's bind host.
 *
 * The webserver row binds loopback by default. This plugin owns a persisted
 * `lan-access` settings namespace (`enabled: true` = bind all interfaces)
 * and converges the running webserver to it:
 *
 * - at boot, after both the settings seam and the webserver exist, the
 *   persisted value is applied once (a mismatch restarts the webserver row);
 * - every settings commit re-applies it, so the General-settings toggle takes
 *   effect immediately;
 * - a fenced /lan-access JSON route (GET state, POST set) lets the browser
 *   settings row read and flip the switch. The fence accepts loopback or the
 *   deployment's trusted authorities, read live from the connection row so
 *   LAN clients are admitted exactly when the /api gateway admits them.
 *
 * Rebinding restarts the webserver fiber, which cascades to every dependent
 * row (web-runtime, connection, api gateway…): web-runtime re-samples the
 * LAN trust snapshot and the connection row re-reads it, so the /api fence
 * admits the LAN authorities after an enable and drops them after a disable.
 *
 * The webserver is read lazily (`ctx.get`) and never injected, so this
 * plugin's own fiber survives the webserver restart it triggers.
 */
import { execFile } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  SettingsConflictError, type SettingsScope,
} from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

/** Bind host values the webserver schema accepts. */
export type LanAccessHost = '127.0.0.1' | '0.0.0.0'

/** The persisted section: whether the GUI listens on all interfaces. */
export interface LanAccessSettings {
  enabled: boolean
}

/** Settings namespace owned by this plugin. */
export const LAN_ACCESS_NAMESPACE = 'lan-access'

/** Durable section schema (defaults to loopback — the safe state). */
export const LanAccessSchema: z<LanAccessSettings> = z.object({
  enabled: z.boolean().default(false),
})

/** One webserver service slice this plugin reads. */
export interface LanAccessWebServer {
  readonly host: LanAccessHost
  readonly port: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** One loader entry slice this plugin reads (the connection row's config). */
export interface LanAccessLoaderEntry {
  /** Fully-qualified entry id (group-prefixed; the address for loader.update). */
  id: string
  options: { name: string; config?: unknown }
  /** The entry's live fiber; its config is the post-interpolation resolved value. */
  fiber?: { config?: unknown }
}

/** The loader service face (structural subset of the cordis-plugin-loader tree). */
export interface LanAccessLoader {
  entries(): Iterable<LanAccessLoaderEntry>
  update(id: string, options: { config?: unknown }): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    loader: LanAccessLoader
    webServer: LanAccessWebServer
    /** The live bind-host source the webserver row's `host` expression reads. */
    lanAccess: LanAccessBindService
  }
}

/**
 * The bind-host source service: the webserver row's composed config carries
 * `host: !!js ctx.get('lanAccess')?.host ?? '127.0.0.1'`, so EVERY webserver
 * fiber (re)start — the initial boot, a toggle-triggered restart, and the
 * post-boot user-patch re-apply alike — evaluates the CURRENT persisted
 * setting instead of a literal that a later patch layer can clobber.
 */
export interface LanAccessBindService {
  /** The host the webserver should bind, from the persisted setting. */
  readonly host: LanAccessHost
}

/** Stable Cordis plugin name (the loader row mounts this package). */
export const name = 'dsh-lan-access'

/** Services required before mounting: the loader tree (for the webserver row and the connection row's trusted hosts). */
export const inject = ['loader']

/** The webserver row's plugin name (matched by name — its entry id is group-prefixed). */
const WEBSERVER_PLUGIN = '@deepseek-ai/dsh-host-webserver'

/** The connection row whose resolved `trustedHosts` the /api fence uses. */
const CONNECTION_ROW = '@deepseek-ai/dsh-client-connection'

/** Request-body size bound of the POST write (defense against unbounded reads). */
const MAX_BODY_BYTES = 64 * 1024

/** An HTTP failure with a wire code and status. */
class LanAccessHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/** Interface names that never carry the machine's routable LAN address. */
const VIRTUAL_INTERFACE = /^(docker|veth|br-|vmnet|utun|tun|tap|tailscale|wg|vbox|virbr|lo|bridge|ppp)/i

/** Interface names that typically carry the primary LAN address (physical NICs). */
const PHYSICAL_INTERFACE = /^(en|eth|wlan|ens|enp|wl|awdl)/i

/** One candidate LAN address with its interface name. */
interface LanAddressCandidate {
  address: string
  name: string
  physical: boolean
}

/**
 * The machine's LAN IPv4 literals, primary first. Nothing is hard-coded: every
 * address is read live from the OS network interfaces of the machine running
 * the DSH server, virtual interfaces (docker/vpn/bridge/loopback) are
 * filtered out, and physical NICs (en0, eth0, wlan0, …) rank ahead of the
 * rest so the first entry is the address another machine on the LAN should
 * open.
 * The /api trust fence admits every returned literal, so any of them works.
 */
function lanAddresses(): string[] {
  const candidates: LanAddressCandidate[] = []
  for (const [name, ifaces] of Object.entries(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface === undefined || iface.family !== 'IPv4' || iface.internal) continue
      if (VIRTUAL_INTERFACE.test(name)) continue
      candidates.push({ address: iface.address, name, physical: PHYSICAL_INTERFACE.test(name) })
    }
  }
  const byAddress = new Map<string, LanAddressCandidate>()
  for (const candidate of candidates) {
    const existing = byAddress.get(candidate.address)
    if (existing === undefined || (candidate.physical && !existing.physical)) {
      byAddress.set(candidate.address, candidate)
    }
  }
  return [...byAddress.values()]
    .sort((left, right) => Number(right.physical) - Number(left.physical))
    .map(candidate => candidate.address)
}

/** Cached primary address (the default-route interface IPv4). */
let primaryCache: { address: string; at: number } | undefined
/** How long a resolved primary address stays fresh (routing rarely changes). */
const PRIMARY_TTL_MS = 30_000

/** The interface owning the default route, from the OS routing table. */
function defaultRouteInterfaceName(): Promise<string | undefined> {
  return new Promise((resolve) => {
    // macOS/BSD: `route -n get default` prints `interface: en0`.
    // Linux: `ip route show default` prints `... dev eth0 ...`.
    const [file, args] = process.platform === 'linux'
      ? ['ip', ['route', 'show', 'default']] as const
      : ['route', ['-n', 'get', 'default']] as const
    execFile(file, args, { timeout: 1500, windowsHide: true }, (error, stdout) => {
      if (error !== null) {
        resolve(undefined)
        return
      }
      const text = String(stdout)
      const mac = /interface:\s*(\S+)/.exec(text)
      const linux = /\bdev\s+(\S+)/.exec(text)
      resolve(mac?.[1] ?? linux?.[1])
    })
  })
}

/**
 * The ONE address another machine should open: the IPv4 of the interface that
 * owns the default route (the NIC the LAN actually reaches the machine
 * through), falling back to the first physical-NIC candidate. The row shows
 * only this address; the /api fence still admits every LAN literal.
 */
async function primaryLanAddress(): Promise<string | undefined> {
  const now = Date.now()
  if (primaryCache !== undefined && now - primaryCache.at < PRIMARY_TTL_MS) {
    return primaryCache.address
  }
  const ifaceName = await defaultRouteInterfaceName()
  let address: string | undefined
  if (ifaceName !== undefined) {
    const iface = networkInterfaces()[ifaceName]?.find(candidate =>
      candidate !== undefined && candidate.family === 'IPv4' && !candidate.internal)
    address = iface?.address
  }
  address ??= lanAddresses()[0]
  primaryCache = { address, at: now }
  return address
}
/* ── browser-trust fence (behaviorally identical to the /api gateway's fence
   in @deepseek-ai/dsh-client-connection; helpers restated because the package
   does not export them and this plugin must not depend on its internals).
   Host-header loopback or a configured trusted authority passes; cross-site
   browser markers refuse. This is a DNS-rebinding / cross-site defense, not
   authentication. */

function header(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host-header authority, or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/** Whether a normalized URL hostname names the local loopback authority. */
function isLoopbackHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/** Canonical authority form: hostname, or hostname:port when a port was written. */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/** Decide whether one request may reach the plugin route. */
function isTrustedApiRequest(req: IncomingMessage, trustedHosts: readonly string[]): boolean {
  const host = header(req.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
  const origin = header(req.headers, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/* ── /lan-access route ──────────────────────────────────────────────────── */

/** Wire state of the LAN-access feature. */
export interface LanAccessState {
  /** Whether the settings seam and webserver are both up (false while booting). */
  ready: boolean
  /** The persisted enabled flag. */
  enabled: boolean
  /** The current webserver bind host. */
  host: LanAccessHost | null
  /** The current webserver port. */
  port: number | null
  /** Whether a bind change is currently being applied. */
  pending: boolean
  /** LAN IPv4 literals served while bound to all interfaces. */
  addresses: string[]
  /** The LAN URL to open from other devices, when one is served. */
  url: string | null
}

/** Read the connection row's resolved trusted authorities, live. */
function trustedHostsOf(loader: LanAccessLoader): string[] {
  for (const entry of loader.entries()) {
    if (entry.options.name !== CONNECTION_ROW) continue
    // Prefer the fiber's RESOLVED config (the post-interpolation value the
    // /api fence itself reads): the composed row carries
    // `trustedHosts: !!js ctx.webRuntime.trustedHosts`, which only the
    // connection fiber may evaluate. The fiber re-resolves after a rebind
    // (web-runtime re-provisions the LAN snapshot), so the fence stays live.
    const fiberConfig = (entry as { fiber?: { config?: unknown } }).fiber?.config as
      { trustedHosts?: unknown } | undefined
    const raw = fiberConfig?.trustedHosts
    if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string')
    return []
  }
  return []
}

/** Read a bounded JSON request body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new LanAccessHttpError('payload-too-large', 'request body too large', 413)
    }
    chunks.push(buffer)
  }
  if (total === 0) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new LanAccessHttpError('bad-request', 'request body is not valid JSON', 400)
  }
}

/** Write one JSON response (the socket may die mid-rebind; never throw). */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  } catch {
    /* the request already dropped (webserver restart) — nothing to answer */
  }
}

/* ── settings/credentials RPC proxy ───────────────────────────────────────
   The /api gateway pins the whole configuration plane (settings.*,
   credentials.*) to loopback even on trusted-host deployments. For a
   LAN-served GUI this plugin mirrors the settings + credentials domains on
   its own fenced route (/lan-access/rpc) so the remote Settings surfaces
   (Models provider directory, Plugins cards, Language/Appearance rows)
   work. The proxy reuses the same exposure boundary as the /api gateway:
   model-provider namespaces plus the web/product allowlist, redacted
   values, revision-fenced writes, and the same error codes. It is not a
   bypass — the route sits behind the identical browser-trust fence. */

/** Web-surface settings namespaces the /api proxy exposes (its allowlist mirror). */
const WEB_SETTINGS_NAMESPACES = [
  'agent-loop', 'shell', 'locale', 'permission', 'ui-conversation', 'ui-theme', 'web-search-deepseek',
] as const

/** Product-owned settings namespaces (the api-proxy's product allowlist mirror). */
const PRODUCT_SETTINGS_NAMESPACES = ['ui-onboarding', 'agent-presets'] as const

/** The llm service face used to enumerate configurable provider namespaces. */
interface LanAccessLlmService {
  listConfigurableProviders(): Array<{ settingsNs: string }>
}

/** The settings seam face (structural subset of SettingsProvider). */
interface LanAccessSettingsSeam {
  readonly writable: boolean
  readonly documentPath?: string
  describe(options?: { redactSecrets?: boolean }): unknown[]
  update(ns: string, patch: object, expectedRevision?: number): Promise<void>
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>
  mutate(ns: string, ops: readonly unknown[], expectedRevision?: number): Promise<void>
  prepareDocument(): Promise<string | undefined>
}

/** Open one path with the OS default application (Finder/Explorer/xdg-open). */
function openWithSystem(path: string): void {
  if (process.platform === 'darwin') {
    execFile('open', [path], { timeout: 5000 }, () => {})
  } else if (process.platform === 'linux') {
    execFile('xdg-open', [path], { timeout: 5000 }, () => {})
  } else {
    execFile('cmd', ['/c', 'start', '', path], { timeout: 5000 }, () => {})
  }
}

/** The credentials seam face (structural subset of CredentialProvider). */
interface LanAccessCredentialsSeam {
  describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>
  set(ref: string, value: string): Promise<void>
  unset(ref: string): Promise<void>
}

/** One RPC result envelope (mirror of the /api RpcResult wire form). */
type LanAccessRpcResult =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }

/** One RPC response envelope; rpcId echoes the request. */
interface LanAccessRpcResponse {
  rpcId: string
  result: LanAccessRpcResult
}

function rpcOk(rpcId: string, value: unknown): LanAccessRpcResponse {
  return { rpcId, result: { ok: true, value } }
}

function rpcErr(
  rpcId: string,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): LanAccessRpcResponse {
  return { rpcId, result: { ok: false, error: { code, message, details } } }
}

/** The settings namespaces this proxy serves — the api-proxy exposure mirror. */
function exposedSettingsNamespaces(ctx: Context): Set<string> {
  const exposed = new Set<string>(WEB_SETTINGS_NAMESPACES)
  for (const ns of PRODUCT_SETTINGS_NAMESPACES) exposed.add(ns)
  const llm = ctx.get('llm') as LanAccessLlmService | undefined
  for (const entry of llm?.listConfigurableProviders() ?? []) exposed.add(entry.settingsNs)
  return exposed
}

/** Map one redacted settings descriptor to its wire view (api-proxy namespaceView mirror). */
function namespaceViewOf(descriptor: {
  ns: unknown
  schema: unknown
  value: unknown
  base?: unknown
  user?: unknown
  applies: string
  revision: number
  secrets?: Array<{ path: readonly string[]; set: boolean }>
}): Record<string, unknown> {
  return {
    ns: String(descriptor.ns),
    schema: descriptor.schema,
    value: descriptor.value,
    ...descriptor.base === undefined ? {} : { base: descriptor.base },
    ...descriptor.user === undefined ? {} : { user: descriptor.user },
    applies: descriptor.applies,
    secrets: (descriptor.secrets ?? []).map(secret => ({ path: [...secret.path], set: secret.set })),
    revision: descriptor.revision,
  }
}

/** settings.update/replace/mutate with the api-proxy exposure + error mapping. */
async function settingsWriteRpc(
  ctx: Context,
  rpcId: string,
  ns: string,
  mode: 'update' | 'replace' | 'mutate',
  section: unknown,
  expectedRevision?: number,
): Promise<LanAccessRpcResponse> {
  const settings = ctx.get('settings') as LanAccessSettingsSeam | undefined
  if (settings === undefined) return rpcErr(rpcId, 'internal', 'settings service is absent')
  if (!exposedSettingsNamespaces(ctx).has(ns)) {
    return rpcErr(rpcId, 'settings-not-exposed', `settings namespace "${ns}" is not exposed to configuration clients`)
  }
  try {
    if (mode === 'update') await settings.update(ns, section as object, expectedRevision)
    else if (mode === 'replace') await settings.replace(ns, section as object, expectedRevision)
    else await settings.mutate(ns, section as readonly unknown[], expectedRevision)
  } catch (error: unknown) {
    if (error instanceof SettingsConflictError) {
      return rpcErr(rpcId, 'settings-conflict', error.message, {
        ns, expected: error.expected, actual: error.actual,
      })
    }
    return rpcErr(rpcId, 'settings-rejected', error instanceof Error ? error.message : String(error))
  }
  const descriptor = (settings.describe({ redactSecrets: true }) as Array<{ ns: unknown }>).find(candidate => String(candidate.ns) === ns)
  if (descriptor === undefined) {
    return rpcErr(rpcId, 'internal', `settings namespace "${ns}" was disposed after the ${mode}`)
  }
  return rpcOk(rpcId, namespaceViewOf(descriptor as Parameters<typeof namespaceViewOf>[0]))
}

/** Dispatch one proxied settings/credentials method (mirror of the /api domains). */
async function dispatchLanAccessRpc(ctx: Context, method: string, payload: unknown): Promise<LanAccessRpcResponse> {
  const record = (payload ?? {}) as Record<string, unknown>
  const rpcId = typeof record.rpcId === 'string' ? record.rpcId : 'lan-access'
  switch (method) {
    case 'settings.describe': {
      const settings = ctx.get('settings') as LanAccessSettingsSeam | undefined
      if (settings === undefined) return rpcErr(rpcId, 'internal', 'settings service is absent')
      const exposed = exposedSettingsNamespaces(ctx)
      return rpcOk(rpcId, {
        writable: settings.writable,
        hasDocument: settings.documentPath !== undefined,
        namespaces: (settings.describe({ redactSecrets: true }) as Parameters<typeof namespaceViewOf>[0][])
          .filter(descriptor => exposed.has(String(descriptor.ns)))
          .map(namespaceViewOf),
      })
    }
    case 'settings.update':
    case 'settings.replace':
    case 'settings.mutate': {
      const ns = record.ns
      if (typeof ns !== 'string') return rpcErr(rpcId, 'bad-request', 'expected a string "ns"')
      const expectedRevision = typeof record.expectedRevision === 'number' ? record.expectedRevision : undefined
      const section = method === 'settings.update' ? record.patch : method === 'settings.replace' ? record.section : record.ops
      return settingsWriteRpc(ctx, rpcId, ns, method.slice('settings.'.length) as 'update' | 'replace' | 'mutate', section, expectedRevision)
    }
    case 'settings.openDocument': {
      const settings = ctx.get('settings') as LanAccessSettingsSeam | undefined
      if (settings === undefined) return rpcErr(rpcId, 'internal', 'settings service is absent')
      let path: string | undefined
      try {
        path = await settings.prepareDocument()
      } catch (error: unknown) {
        return rpcErr(rpcId, 'internal', `settings document preparation failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      if (path === undefined) return rpcErr(rpcId, 'internal', 'settings provider has no local document to open')
      openWithSystem(path)
      return rpcOk(rpcId, { opened: true })
    }
    case 'credentials.describe': {
      const credentials = ctx.get('credentials') as LanAccessCredentialsSeam | undefined
      if (credentials === undefined) return rpcErr(rpcId, 'internal', 'credentials service is absent')
      const refs = record.refs
      if (!Array.isArray(refs) || refs.some(ref => typeof ref !== 'string')) {
        return rpcErr(rpcId, 'bad-request', 'expected an array of string refs')
      }
      const entries: Record<string, unknown> = {}
      for (const ref of refs as string[]) {
        try {
          const info = await credentials.describe(credentialRef(ref))
          entries[ref] = {
            configured: info.configured,
            ...info.source === undefined ? {} : { source: info.source },
            writable: info.writable,
          }
        } catch (error: unknown) {
          return rpcErr(rpcId, 'credential-rejected', error instanceof Error ? error.message : String(error), { ref })
        }
      }
      return rpcOk(rpcId, { credentials: entries })
    }
    case 'credentials.set':
    case 'credentials.unset': {
      const credentials = ctx.get('credentials') as LanAccessCredentialsSeam | undefined
      if (credentials === undefined) return rpcErr(rpcId, 'internal', 'credentials service is absent')
      const ref = record.ref
      if (typeof ref !== 'string') return rpcErr(rpcId, 'bad-request', 'expected a string "ref"')
      try {
        if (method === 'credentials.set') {
          const value = record.value
          if (typeof value !== 'string') return rpcErr(rpcId, 'bad-request', 'expected a string "value"')
          await credentials.set(credentialRef(ref), value)
        } else {
          await credentials.unset(credentialRef(ref))
        }
      } catch (error: unknown) {
        return rpcErr(rpcId, 'credential-rejected', error instanceof Error ? error.message : String(error), { ref })
      }
      return rpcOk(rpcId, {})
    }
    default:
      return rpcErr(rpcId, 'not-found', `unknown lan-access rpc method "${method}"`)
  }
}

/** The /lan-access/rpc route handler: fenced, POST-only, envelope-mirroring. */
async function handleRpc(
  ctx: Context,
  loader: LanAccessLoader,
  req: IncomingMessage,
  res: ServerResponse,
  log?: (method: string, ok: boolean, code?: string, ns?: string, namespaces?: string[]) => void,
): Promise<void> {
  if (!isTrustedApiRequest(req, trustedHostsOf(loader))) {
    writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'request origin is not trusted' } })
    return
  }
  if (req.method !== 'POST') {
    writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
    return
  }
  const body = await readJsonBody(req)
  const record = (body ?? {}) as Record<string, unknown>
  if (typeof record.method !== 'string' || typeof record.payload !== 'object' || record.payload === null) {
    writeJson(res, 400, { ok: false, error: { code: 'bad-request', message: 'expected {"method", "payload"}' } })
    return
  }
  const rpcId = typeof record.rpcId === 'string' ? record.rpcId : 'lan-access'
  const response = await dispatchLanAccessRpc(ctx, record.method, { rpcId, ...(record.payload as object) })
  if (log !== undefined) {
    const ns = (record.payload as { ns?: unknown } | null)?.ns
    const namespaces = response.result.ok
      ? (response.result.value as { namespaces?: Array<{ ns: unknown }> } | null)?.namespaces?.map(view => String(view.ns))
      : undefined
    log(
      record.method,
      response.result.ok,
      response.result.ok ? undefined : response.result.error.code,
      typeof ns === 'string' ? ns : undefined,
      namespaces,
    )
  }
  writeJson(res, 200, response)
}


/**
 * Mount the LAN-access controller.
 * @param ctx - host context (loader injected).
 */
export function apply(ctx: Context): void {
  const loader = ctx.loader
  // The live bind-host source for the webserver row's `host` expression
  // (`!!js ctx.get('lanAccess')?.host ?? '127.0.0.1'`, composed by this
  // plugin's bundle patch). Provided by this fiber, which depends only on the
  // loader, so it survives every webserver restart.
  ctx.provide('lanAccess', {
    get host(): LanAccessHost {
      return scope?.get().enabled === true ? '0.0.0.0' : '127.0.0.1'
    },
  } satisfies LanAccessBindService)
  // The owner scope, once the settings child fiber registers the namespace.
  let scope: SettingsScope<LanAccessSettings> | undefined
  // Client boot diagnostics (the last few browser reports; debug aid).
  const diagReports: Array<{ at: number; data: unknown }> = []
  // RPC traffic log (the last 60 proxied calls; debug aid).
  const rpcTraffic: Array<{ at: number; method: string; ok: boolean; code?: string; ns?: string; namespaces?: string[] }> = []
  const logRpc = (method: string, ok: boolean, code?: string, ns?: string, namespaces?: string[]): void => {
    rpcTraffic.push({ at: Date.now(), method, ok, code, ns, namespaces })
    if (rpcTraffic.length > 60) rpcTraffic.shift()
  }
  // Serialized bind application: concurrent toggles queue; the chain stays
  // fulfilled so one failure cannot strand later writes.
  let applying: Promise<void> = Promise.resolve()
  let pendingCount = 0

  const serverOf = (): LanAccessWebServer | undefined =>
    ctx.get('webServer') as LanAccessWebServer | undefined

  const warn = (phase: string, error: unknown): void => {
    ctx.logger.warn('[dsh-lan-access] %s: %s', phase, error instanceof Error ? error.message : String(error))
  }

  /** Find the webserver loader entry by plugin name (its id is group-prefixed). */
  const webserverEntry = (): LanAccessLoaderEntry | undefined => {
    for (const entry of loader.entries()) {
      if (entry.options.name === WEBSERVER_PLUGIN) return entry
    }
    return undefined
  }

  /** Queue one bind convergence; no-ops when the webserver already binds the desired host. */
  const enqueueApply = (enabled: boolean): Promise<void> => {
    pendingCount += 1
    const task = applying.then(async () => {
      const server = serverOf()
      if (server === undefined) return
      const desiredHost: LanAccessHost = enabled ? '0.0.0.0' : '127.0.0.1'
      if (server.host === desiredHost) return
      const entry = webserverEntry()
      if (entry === undefined) {
        throw new Error('webserver loader entry not found')
      }
      // Restate the webserver row config (host + the current port) to force
      // the fiber restart: the loader rebinds the socket and reloads every
      // dependent row (web-runtime re-samples LAN trust, the connection row
      // re-reads it into the /api fence). The row's composed `host`
      // expression (this plugin's bundle patch) is what any later
      // recomposition re-applies, and it reads the live `lanAccess` service
      // — so a post-boot user-patch re-apply converges to the SAME persisted
      // host instead of reverting to the bundle default.
      await loader.update(entry.id, { config: { host: desiredHost, port: server.port } })
    })
    applying = task.catch(() => {})
    void task.finally(() => { pendingCount -= 1 }).catch(() => {})
    return task
  }

  /** Converge the webserver bind to the persisted setting once both sides exist. */
  const align = (): void => {
    if (scope === undefined || serverOf() === undefined) return
    void enqueueApply(scope.get().enabled).catch(error => warn('align', error))
  }

  const stateOf = async (): Promise<LanAccessState> => {
    const server = serverOf()
    const enabled = scope?.get().enabled ?? false
    const addresses = enabled ? lanAddresses() : []
    const primary = enabled ? await primaryLanAddress() : undefined
    return {
      ready: scope !== undefined && server !== undefined,
      enabled,
      host: server?.host ?? null,
      port: server?.port ?? null,
      pending: pendingCount > 0,
      addresses,
      url: primary !== undefined && server !== undefined
        ? `http://${primary}:${server.port}`
        : null,
    }
  }

  // The durable section: register the namespace, follow every commit, and
  // align at boot. This child fiber depends on the settings seam only, so a
  // webserver restart never tears it down.
  ctx.inject(['settings'], (sctx) => {
    scope = sctx.settings.register<typeof LAN_ACCESS_NAMESPACE, LanAccessSettings>(LAN_ACCESS_NAMESPACE, LanAccessSchema)
    scope.watch((next) => {
      void enqueueApply(next.enabled).catch(error => warn('settings change', error))
    })
    align()
  })

  // The fenced route + boot alignment. This child fiber reloads after a
  // rebind (the webserver service disappears and returns), re-registering
  // the route on the fresh server.
  ctx.inject(['webServer'], (httpCtx) => {
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: '/lan-access',
      handler: (req, res) => {
        void handle(req, res).catch((error: unknown) => {
          if (error instanceof LanAccessHttpError) {
            writeJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
            return
          }
          writeJson(res, 500, {
            ok: false,
            error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
          })
        })
      },
    }), 'dsh-lan-access: /lan-access route')

    // The settings/credentials RPC proxy (mirrors the loopback-pinned /api
    // configuration plane for LAN-served pages; same fence, same envelopes).
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: '/lan-access/rpc',
      handler: (req, res) => {
        void handleRpc(ctx, loader, req, res, (method, ok, code, ns, namespaces) => logRpc(method, ok, code, ns, namespaces)).catch((error: unknown) => {
          writeJson(res, 500, {
            ok: false,
            error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
          })
        })
      },
    }), 'dsh-lan-access: /lan-access/rpc route')

    // Client boot diagnostics: browsers POST their ledger state after boot;
    // GET reads the last reports (debug aid for LAN settings issues).
    httpCtx.effect(() => httpCtx.webServer.register({
      kind: 'exact',
      path: '/lan-access/diag',
      handler: (req, res) => {
        void (async () => {
          if (!isTrustedApiRequest(req, trustedHostsOf(loader))) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'request origin is not trusted' } })
            return
          }
          if (req.method === 'POST') {
            const body = await readJsonBody(req)
            diagReports.push({ at: Date.now(), data: body })
            if (diagReports.length > 20) diagReports.shift()
            writeJson(res, 200, { ok: true })
            return
          }
          writeJson(res, 200, { ok: true, value: { reports: diagReports, traffic: rpcTraffic } })
        })().catch((error: unknown) => {
          writeJson(res, 500, {
            ok: false,
            error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
          })
        })
      },
    }), 'dsh-lan-access: /lan-access/diag route')
    align()
  })

  /** One /lan-access request: GET reads state, POST persists and applies. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    if (url.pathname !== '/lan-access') {
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: 'not found' } })
      return
    }
    if (!isTrustedApiRequest(req, trustedHostsOf(loader))) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'request origin is not trusted' } })
      return
    }
    if (req.method === 'GET') {
      writeJson(res, 200, { ok: true, value: await stateOf() })
      return
    }
    if (req.method === 'POST') {
      const payload = await readJsonBody(req)
      if (payload === null || typeof payload !== 'object' || typeof (payload as { enabled?: unknown }).enabled !== 'boolean') {
        throw new LanAccessHttpError('bad-request', 'expected {"enabled": boolean}')
      }
      const enabled = (payload as { enabled: boolean }).enabled
      const settings = ctx.get('settings')
      if (settings === undefined || scope === undefined) {
        throw new LanAccessHttpError('not-ready', 'LAN access settings are not ready yet', 503)
      }
      // Persist first (the commit fires the watch → enqueueApply), then make
      // sure the bind follows even if the watch raced this request.
      await settings.update(LAN_ACCESS_NAMESPACE, { enabled })
      await enqueueApply(enabled)
      writeJson(res, 200, { ok: true, value: await stateOf() })
      return
    }
    writeJson(res, 405, { ok: false, error: { code: 'method-error', message: 'method not allowed' } })
  }
}
