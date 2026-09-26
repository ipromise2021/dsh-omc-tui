/**
 * Read a stable Session event snapshot across supported Harness releases.
 * DSH v0.1.2 replaced the legacy `events` getter with `snapshotEvents()`.
 */
export function sessionEvents(session) {
  if (!session) return []
  if (typeof session.snapshotEvents === 'function') {
    const events = session.snapshotEvents()
    return Array.isArray(events) ? events : []
  }
  return Array.isArray(session.events) ? session.events : []
}

/**
 * Read the paired tool-call id from a tool/call or tool/result event across
 * Harness releases. DSH v0.1.5 moved the result correlation from the
 * event-data root into the result message source (`message.source.callId`);
 * older logs keep it at the root as `callId` or `id`.
 */
export function toolCallId(data) {
  return data?.callId ?? data?.id ?? data?.message?.source?.callId
}

/**
 * Normalize the V3 and V4 tool-result failure markers. V4 stores the flag on
 * its first-class tool message; older persisted events put it on event data.
 */
export function toolResultFailure(data) {
  return data?.isError === true || data?.message?.isError === true || data?.error !== undefined
}

/** Read a compact, display-safe failure description across the V3/V4 shapes. */
export function toolResultError(data) {
  const error = data?.error
  if (typeof error === 'string') return { code: 'error', detail: error }
  if (error && typeof error === 'object') {
    return {
      code: error.code ?? error.name ?? 'error',
      detail: error.reason ?? error.message
    }
  }
  return { code: 'error', detail: undefined }
}

/**
 * Read the current permission preset across the v0.1.1 and v0.1.2 APIs.
 * v0.1.1 accepts an event array; v0.1.2 accepts the Session itself.
 */
export function currentPermissionPreset(service, session) {
  if (!service || typeof service.current !== 'function' || !session) return undefined
  return typeof session.snapshotEvents === 'function'
    ? service.current(session)
    : service.current(sessionEvents(session))
}
