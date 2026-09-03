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
 * Read the current permission preset across the v0.1.1 and v0.1.2 APIs.
 * v0.1.1 accepts an event array; v0.1.2 accepts the Session itself.
 */
export function currentPermissionPreset(service, session) {
  if (!service || typeof service.current !== 'function' || !session) return undefined
  return typeof session.snapshotEvents === 'function'
    ? service.current(session)
    : service.current(sessionEvents(session))
}
