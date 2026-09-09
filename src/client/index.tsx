/**
 * Client half of dsh-lan-access. Two jobs:
 *
 * 1. A runtime connection patch that makes LAN-served pages behave like the
 *    local page WITHOUT any harness change: `connection.isLoopback` is
 *    widened to "loopback OR served LAN authority" (so settingsScope-bound
 *    surfaces use host persistence on LAN), and the loopback-pinned
 *    `api.settings.*` / `api.credentials.*` calls are routed through this
 *    plugin's fenced /lan-access/rpc proxy. The plugin injects only
 *    `connection`, which is available in the first boot wave — before any
 *    settings surface binds — so the patch is in place deterministically.
 *
 * 2. The LAN-access toggle row in the Settings shell's General section
 *    (`settings.general.item`), which reads and writes the fenced
 *    /lan-access host route; the host owns the settings namespace and the
 *    webserver rebind.
 */
import type { Context } from '@deepseek-ai/cordis'
import { LanAccessRow, type LanAccessRowInjected } from './LanAccessRow.tsx'
import { attachLocale, en, LOCALE_NS, zh, type LanAccessLocaleService } from './locales.ts'
import { installRandomUUIDPolyfill } from './polyfill.ts'
import { installConnectionPatch, type LanAccessConnectionHandle } from './connection-patch.ts'

/** The client slots service face (subset of the runtime SlotRegistry). */
export interface LanAccessSlotsService {
  register(options: {
    name: string
    id?: string
    order?: number
    locale?: string
    inject?: (...args: unknown[]) => object
  }, component: unknown): () => void
  /** Run a callback for each declaration lifetime of a slot (no-op while undeclared). */
  inject(key: string, callback: () => () => void): () => void
  /** Entries registered into a slot (diagnostics use). */
  entries(key: string): unknown[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: LanAccessSlotsService
    locale: LanAccessLocaleService
    connection: LanAccessConnectionHandle
  }
}

// Module scope: run as soon as this bundle materializes. On a plain-HTTP LAN
// origin crypto.randomUUID does not exist (non-secure context), which breaks
// every API RPC ("crypto.randomUUID is not a function"); the connection loop
// retries with backoff, so the polyfill lands before its next handshake.
installRandomUUIDPolyfill()

/**
 * Services required before mounting: only the connection, so this plugin's
 * apply runs after the connection row provides its handle but still before
 * the settings surfaces (which wait on `remote` / `settingsScope`). That
 * ordering is what lets the isLoopback widening below land before ui-settings
 * reads `remote.$host.isLoopback` for the settingsScope persistence decision
 * — a non-loopback page would otherwise degrade settings to memory mode, and
 * the Models page / Plugins cards would render nothing.
 */
export const inject: string[] = ['connection']

/**
 * Client plugin body.
 * @param ctx - the client cordis context (slots/locale via child fiber).
 */
export function apply(ctx: Context): void {
  // Defensive re-install (module scope already ran; tests may mount directly).
  installRandomUUIDPolyfill()
  // The connection patch: served-authority classification. The connection is
  // injected (see `inject` above), and `ctx.effect` runs its body
  // synchronously during apply — so the widening lands before any settings
  // surface finishes fetching — instead of from a deferred async-generator
  // effect that could land after ui-settings has already read
  // `remote.$host.isLoopback` and committed to memory-mode persistence. The
  // returned disposer is collected for HMR-safe teardown.
  ctx.effect(
    () => installConnectionPatch(ctx.get('connection') as LanAccessConnectionHandle),
    'dsh-lan-access: connection patch',
  )

  // The settings row + dictionaries need slots/locale, which arrive later;
  // mount them in a child fiber that waits for those services.
  ctx.inject(['slots', 'locale'], (uiCtx) => {
    // The connection handle for the diagnostics below (the connection row has
    // long applied by the time this child fiber runs; keep it defensive).
    let connection: LanAccessConnectionHandle | undefined
    try { connection = ctx.get('connection') as LanAccessConnectionHandle | undefined } catch { /* not yet */ }

    // Follow the DSH i18n system: register the plugin's dictionaries into the
    // shared locale registry; the row re-renders on locale switches through
    // the bound service. Disposers run on fiber disposal (HMR-safe).
    attachLocale(uiCtx.locale)
    uiCtx.effect(() => {
      const offZh = uiCtx.locale.register(LOCALE_NS, 'zh', zh)
      const offEn = uiCtx.locale.register(LOCALE_NS, 'en', en)
      return () => { offZh(); offEn() }
    }, 'dsh-lan-access: dictionaries')

    // The General-settings row: contributed only while the General entry
    // declares the item slot.
    uiCtx.slots.inject('settings.general.item', () => uiCtx.slots.register({
      name: 'settings.general.item',
      id: 'lan-access',
      order: 15,
      inject: (): LanAccessRowInjected => ({}),
    }, LanAccessRow))

    // Boot diagnostics (debug aid): report the settings slot ledger state so
    // the host's /lan-access/diag can show whether the plugins page's section,
    // tab, and card registrations landed in this browser.
    const report = (): void => {
      const count = (key: string): number => uiCtx.slots.entries(key).length
      void fetch('/lan-access/diag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          slots: {
            'settings.section': count('settings.section'),
            'settings.general.item': count('settings.general.item'),
            'settings.plugins.tab': count('settings.plugins.tab'),
            'settings.plugin.item': count('settings.plugin.item'),
          },
          isLoopback: connection?.isLoopback === true,
          patched: (connection as { __lanAccessPatched?: boolean } | undefined)?.__lanAccessPatched === true,
          origin: typeof location !== 'undefined' ? location.origin : 'no-location',
          ua: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 100) : 'no-navigator',
        }),
      }).catch(() => {})
    }
    // First report at boot; a second after a short delay (registrations that
    // depend on late service arrivals settle within a second).
    report()
    setTimeout(report, 1500)

    // Scope probe: bind the same 'shell' namespace the Plugins page's Shell
    // card uses and report the resulting scope status — 'ready' means the
    // host-mode + proxy path works end to end in this browser; 'loading' or
    // 'unavailable' pinpoints where it does not.
    const settingsScope = ctx.get('settingsScope') as {
      bind<T>(spec: { namespace: string }): {
        getSnapshot(): { status: string; value?: T }
      }
    } | undefined
    let probe: { getSnapshot(): { status: string } } | undefined
    if (settingsScope !== undefined) {
      probe = settingsScope.bind<Record<string, unknown>>({ namespace: 'shell' })
      setTimeout(() => {
        void fetch('/lan-access/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ scopeProbe: probe?.getSnapshot() }),
        }).catch(() => {})
      }, 2500)
    }

    // Render-path poll (debug aid): every 2s, report what the OUTLET would
    // see for the plugin-item slot — raw entries, shadowing winners, the
    // declared spec, and each card's own injected snapshot (the card renders
    // nothing while `available` is false). Correlating this with the DOM
    // decides between "entries/spec gone", "cards abdicated", and
    // "cards present but rendering null".
    const wideSlots = uiCtx.slots as LanAccessSlotsService & {
      entriesOfSlot?(key: string): Array<{ options?: { id?: string } }>
      specDynamic?(key: string): { kind?: string; scope?: string } | undefined
    }
    const cardFace = (entry: { options?: { id?: string }; inject?: () => unknown }): unknown => {
      try {
        const face = entry.inject?.() as Record<string, unknown> | undefined
        const hooks = face?.hooks as Record<string, { getSnapshot(): unknown }> | undefined
        const hook = hooks !== undefined ? Object.values(hooks)[0] : undefined
        return hook?.getSnapshot() ?? null
      } catch (error) {
        return { threw: String(error) }
      }
    }
    const poll = (): void => {
      const entries = wideSlots.entries('settings.plugin.item') as Array<{ options?: { id?: string }; inject?: () => unknown }>
      const cardEntries = entries.map(entry => ({
        id: entry.options?.id ?? '?',
        state: cardFace(entry),
      }))
      void fetch('/lan-access/diag', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          poll: {
            entries: entries.map(entry => entry.options?.id ?? '?'),
            entriesOfSlot: (wideSlots.entriesOfSlot?.('settings.plugin.item') ?? []).map(entry => entry.options?.id ?? '?'),
            spec: wideSlots.specDynamic?.('settings.plugin.item') ?? null,
            cards: cardEntries,
            isLoopback: connection?.isLoopback === true,
            patched: (connection as { __lanAccessPatched?: boolean } | undefined)?.__lanAccessPatched === true,
            probe: probe?.getSnapshot?.() ?? null,
          },
        }),
      }).catch(() => {})
    }
    const pollStop = setInterval(poll, 2000)
    poll()
    // Bound the chatter: the poll is a boot-time debug aid, not a live metric.
    setTimeout(() => { clearInterval(pollStop) }, 60000)
    uiCtx.effect(() => () => { clearInterval(pollStop) }, 'dsh-lan-access: diag poll')
  })
}
