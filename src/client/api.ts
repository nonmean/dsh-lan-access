/**
 * Typed fetch wrapper over the fenced /lan-access JSON route. Same-origin
 * only: the route itself re-checks the Host/Origin against the deployment's
 * trust fence, so a cross-site fetch is refused server-side too.
 */

/** Wire state of the LAN-access feature. */
export interface LanAccessState {
  /** Whether the webserver is up (false while booting). */
  ready: boolean
  /** The persisted enabled flag. */
  enabled: boolean
  /** The current webserver bind host. */
  host: '127.0.0.1' | '0.0.0.0' | null
  /** The current webserver port. */
  port: number | null
  /** Whether a bind change is currently being applied. */
  pending: boolean
  /** LAN IPv4 literals served while bound to all interfaces. */
  addresses: string[]
  /** The LAN URL to open from other devices, when one is served. */
  url: string | null
}

/** One wire failure (network errors carry code 'network'). */
export class LanAccessApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Wire envelope of one call. */
interface LanAccessEnvelope {
  ok?: boolean
  value?: unknown
  error?: { code?: string; message?: string }
}

async function call(path: string, init?: RequestInit): Promise<LanAccessState> {
  let response: Response
  try {
    response = await fetch(path, init)
  } catch (error) {
    throw new LanAccessApiError('network', error instanceof Error ? error.message : String(error))
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new LanAccessApiError('bad-response', 'lan-access: response is not JSON')
  }
  const envelope = body as LanAccessEnvelope
  if (envelope.ok !== true || envelope.value === undefined || typeof envelope.value !== 'object') {
    throw new LanAccessApiError(
      envelope.error?.code ?? 'unknown',
      envelope.error?.message ?? 'lan-access: request failed',
    )
  }
  return envelope.value as LanAccessState
}

/** Read the current state. */
export function getState(signal?: AbortSignal): Promise<LanAccessState> {
  return call('/lan-access', { signal, headers: { accept: 'application/json' } })
}

/** Persist and apply one enabled value (the host restarts the web server). */
export function setEnabled(enabled: boolean): Promise<LanAccessState> {
  return call('/lan-access', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ enabled }),
  })
}
