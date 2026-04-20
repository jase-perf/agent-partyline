/**
 * presence.ts — Read the current list of registered sessions from the
 * dashboard/switchboard HTTP API. Pure HTTP; no state, no heartbeats.
 */

export interface PresenceSession {
  name: string
  online: boolean
  cc_session_uuid: string | null
  cwd: string
}

export async function listSessions(
  switchboardUrl: string,
  cookie?: string,
): Promise<PresenceSession[]> {
  const res = await fetch(switchboardUrl.replace(/\/$/, '') + '/ccpl/sessions', {
    headers: cookie ? { cookie } : {},
  })
  if (!res.ok) throw new Error(`listSessions: ${res.status}`)
  const body = (await res.json()) as { sessions: PresenceSession[] }
  return body.sessions
}
