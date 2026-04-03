/** A registered session on the party line. */
export interface Session {
  name: string
  pid: number
  registered_at: string // ISO 8601
}

/** A message on the bus. */
export interface BusMessage {
  id: number
  from: string
  to: string // session name, comma-separated list, or "all"
  type: MessageType
  body: string
  callback_id: string | null
  response_to: string | null // callback_id this is responding to
  created_at: string // ISO 8601
}

export type MessageType = 'message' | 'request' | 'response' | 'status'

/** What gets delivered to Claude via channel notification. */
export interface InboundMessage {
  from: string
  to: string
  type: MessageType
  body: string
  callback_id?: string
  response_to?: string
  message_id: number
}
