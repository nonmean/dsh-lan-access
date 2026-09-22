/**
 * LAN-access preference row in the General settings section (the DSH
 * settings-row recipe: title/description left, control right, hairline
 * separator; the section column strips the trailing one).
 *
 * The row talks to the fenced /lan-access host route directly. Flipping the
 * switch persists the plugin-owned flag and restarts the web server to rebind, so
 * the in-flight request (and any follow-up read) can drop mid-restart: after
 * a write the row polls the route until the server answers again, then
 * reflects the fresh state. Disabling from a remote machine intentionally
 * cuts that machine off — the row then reports the timeout message instead
 * of silently lying about the state.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { LanAccessApiError, getState, setEnabled, type LanAccessState } from './api.ts'
import { activeLocale, subscribeLocale, translate } from './locales.ts'

/** The registration-side injected face (empty — the row owns its own state). */
export interface LanAccessRowInjected {
  /** Marker field: no business face is shared with the apply world. */
  children?: never
}

/** Full component props of the row. */
export type LanAccessRowProps = LanAccessRowInjected

/** Poll cadence while the web server restarts. */
const POLL_INTERVAL_MS = 600
/** Give up after this long without a reachable server. */
const POLL_TIMEOUT_MS = 15000

/** Re-render on locale switches (the DSH locale service is uSES-safe). */
function useLocale(): string {
  return useSyncExternalStore(subscribeLocale, activeLocale)
}

/** Custom switch: a real checkbox (native semantics + focus) driving a styled track/thumb. */
function Switch(props: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (next: boolean) => void
}) {
  const { checked, disabled, label, onChange } = props
  return (
    <label
      style={{
        position: 'relative',
        display: 'inline-flex',
        flex: 'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <input
        type="checkbox"
        className="lan-access-switch-input"
        style={{ position: 'absolute', width: 1, height: 1, margin: 0, opacity: 0 }}
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={event => { onChange(event.currentTarget.checked) }}
      />
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          width: 36,
          height: 20,
          padding: 2,
          boxSizing: 'border-box',
          borderRadius: 10,
          border: '1px solid ' + (checked ? 'var(--dsw-alias-button-primary-fill)' : 'var(--dsw-alias-border-l2)'),
          background: checked ? 'var(--dsw-alias-button-primary-fill)' : 'var(--dsw-alias-bg-layer-1)',
          transition: 'background 0.15s ease, border-color 0.15s ease',
        }}
      >
        <span
          style={{
            display: 'block',
            width: 14,
            height: 14,
            borderRadius: '50%',
            background: checked ? 'var(--dsw-alias-bg-layer-3)' : 'var(--dsw-alias-label-secondary)',
            transform: checked ? 'translateX(16px)' : 'none',
            transition: 'transform 0.15s ease, background 0.15s ease',
          }}
        />
      </span>
    </label>
  )
}

/** Map one failure to copy: network errors and the timeout get friendly text
 *  instead of the raw "Failed to fetch" the browser reports mid-restart. */
function messageOf(error: unknown, fallback: string): string {
  if (error instanceof LanAccessApiError) {
    if (error.code === 'timeout') return translate('timeout')
    if (error.code === 'network') return fallback
  }
  return error instanceof Error && error.message !== '' ? error.message : fallback
}

/** Sleep helper. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Render the LAN-access preference row.
 * @returns the row element tree.
 */
export function LanAccessRow(_props: LanAccessRowProps) {
  useLocale() // re-render on locale switch
  const [state, setState] = useState<LanAccessState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    // The settings seam may still be booting right after a page load, and a
    // rebind restart can cut the first reads — retry a few times before
    // reporting a failure.
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const next = await getState()
        setState(next)
        setError(null)
        return
      } catch (error) {
        const networkish = error instanceof LanAccessApiError
          && (error.code === 'network' || error.code === 'not-ready')
        if (!networkish) {
          setError(messageOf(error, translate('loadFailed')))
          return
        }
        if (attempt < 5) await sleep(700 + attempt * 500)
      }
    }
    setError(translate('loadFailed'))
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Apply one toggle; poll through the server restart, then re-read. */
  const toggle = useCallback(async (next: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      try {
        await setEnabled(next)
      } catch (error) {
        // The rebind restarts the web server mid-request, which cuts the
        // POST's own connection: the write may still have landed, so a
        // network failure is not a failure — keep going and poll for the
        // outcome. Anything else (fence, 4xx/5xx envelope) fails loud.
        if (!(error instanceof LanAccessApiError) || error.code !== 'network') throw error
      }
      const deadline = Date.now() + POLL_TIMEOUT_MS
      for (;;) {
        try {
          const fresh = await getState()
          if (fresh.ready) {
            setState(fresh)
            break
          }
        } catch {
          // The web server is restarting (or this machine just lost access).
        }
        if (Date.now() > deadline) {
          throw new LanAccessApiError('timeout', translate('timeout'))
        }
        await sleep(POLL_INTERVAL_MS)
      }
      setError(null)
    } catch (error) {
      setError(messageOf(error, translate('saveFailed')))
    } finally {
      setBusy(false)
    }
  }, [])

  const enabled = state?.enabled ?? false
  const ready = state?.ready === true && !busy
  const copyUrl = (): void => {
    if (state?.url === null || state?.url === undefined) return
    void navigator.clipboard?.writeText(state.url).then(() => {
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1200)
    }).catch(() => {})
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '16px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l2)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4, paddingRight: 48 }}>
        <div style={{ fontSize: 14, fontWeight: 400, lineHeight: '22px', color: 'var(--dsw-alias-label-primary)' }}>
          {translate('title')}
        </div>
        <div style={{ fontSize: 12, fontWeight: 400, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
          {translate('desc')}
        </div>
        {state?.ready === true && state.enabled && state.url !== null && state.url !== undefined && (
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 2 }}>
            <span style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
              {translate('urlLabel')}
            </span>
            <code
              style={{
                fontSize: 12,
                lineHeight: '18px',
                color: 'var(--dsw-alias-label-primary)',
                background: 'var(--dsw-alias-bg-module-platform)',
                padding: '2px 8px',
                borderRadius: 6,
              }}
            >
              {state.url}
            </code>
            <button
              type="button"
              onClick={copyUrl}
              style={{
                border: 'none',
                background: 'transparent',
                padding: 0,
                font: 'inherit',
                fontSize: 12,
                lineHeight: '18px',
                color: 'var(--dsw-alias-state-business-primary)',
                cursor: 'pointer',
              }}
            >
              {copied ? translate('copied') : translate('copy')}
            </button>
          </div>
        )}
        {state === null && !busy && (
          <div style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
            {translate('loading')}
          </div>
        )}
        {busy && (
          <div style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' }}>
            {translate('applying')}
          </div>
        )}
        {error !== null && (
          <div role="alert" style={{ fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-danger, #d92d20)' }}>
            {error}
          </div>
        )}
      </div>
      <Switch
        checked={enabled}
        disabled={!ready}
        label={translate('title')}
        onChange={(next) => { void toggle(next) }}
      />
    </div>
  )
}
