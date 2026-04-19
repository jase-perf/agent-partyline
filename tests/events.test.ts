import { describe, expect, test } from 'bun:test'
import { validateHookEvent, type HookEvent } from '../src/events.js'

describe('validateHookEvent', () => {
  test('accepts minimal valid PostToolUse event', () => {
    const raw = {
      machine_id: 'm1',
      session_name: 'discord',
      session_id: 's1',
      hook_event: 'PostToolUse',
      ts: '2026-04-19T12:00:00.000Z',
      payload: { tool_name: 'Bash', success: true },
    }
    const ev = validateHookEvent(raw)
    expect(ev.hook_event).toBe('PostToolUse')
    expect(ev.session_name).toBe('discord')
  })

  test('rejects event missing hook_event', () => {
    const raw = { machine_id: 'm1', session_name: 'x', session_id: 's', ts: 't', payload: {} }
    expect(() => validateHookEvent(raw)).toThrow(/hook_event/)
  })

  test('rejects event with non-string machine_id', () => {
    const raw = {
      machine_id: 42,
      session_name: 'x',
      session_id: 's',
      hook_event: 'Stop',
      ts: 't',
      payload: {},
    }
    expect(() => validateHookEvent(raw)).toThrow(/machine_id/)
  })

  test('rejects unknown hook_event value', () => {
    const raw = {
      machine_id: 'm',
      session_name: 'x',
      session_id: 's',
      hook_event: 'Banana',
      ts: 't',
      payload: {},
    }
    expect(() => validateHookEvent(raw)).toThrow(/Banana|unknown/)
  })

  test('rejects non-string agent_id when present', () => {
    const raw = {
      machine_id: 'm',
      session_name: 'x',
      session_id: 's',
      hook_event: 'Stop',
      ts: 't',
      payload: {},
      agent_id: 42,
    }
    expect(() => validateHookEvent(raw)).toThrow(/agent_id/)
  })

  test('accepts event with valid optional agent_id and agent_type', () => {
    const raw = {
      machine_id: 'm',
      session_name: 'x',
      session_id: 's',
      hook_event: 'SubagentStart',
      ts: 't',
      payload: {},
      agent_id: 'a1',
      agent_type: 'Explore',
    }
    const ev = validateHookEvent(raw)
    expect(ev.agent_id).toBe('a1')
    expect(ev.agent_type).toBe('Explore')
  })

  test('rejects non-object raw input', () => {
    expect(() => validateHookEvent(null)).toThrow()
    expect(() => validateHookEvent(42)).toThrow()
    expect(() => validateHookEvent('string')).toThrow()
  })

  test('rejects non-object payload', () => {
    const raw = {
      machine_id: 'm',
      session_name: 'x',
      session_id: 's',
      hook_event: 'Stop',
      ts: 't',
      payload: 'hello',
    }
    expect(() => validateHookEvent(raw)).toThrow(/payload/)
  })
})
