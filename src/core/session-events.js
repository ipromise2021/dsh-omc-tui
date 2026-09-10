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
 * Read the current permission preset across the v0.1.1 and v0.1.2 APIs.
 * v0.1.1 accepts an event array; v0.1.2 accepts the Session itself.
 */
export function currentPermissionPreset(service, session) {
  if (!service || typeof service.current !== 'function' || !session) return undefined
  return typeof session.snapshotEvents === 'function'
    ? service.current(session)
    : service.current(sessionEvents(session))
}
