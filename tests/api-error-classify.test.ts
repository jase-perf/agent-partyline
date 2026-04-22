import { describe, test, expect } from 'bun:test'
import { classifyApiError } from '../dashboard/serve-helpers.js'

describe('classifyApiError', () => {
  test('system api_error with 529 overloaded', () => {
    const entry = {
      type: 'system',
      subtype: 'api_error',
      level: 'error',
      error: {
        status: 529,
        type: 'overloaded_error',
        message: 'Overloaded',
      },
    }
    const r = classifyApiError(entry)
    expect(r).not.toBeNull()
    expect(r!.status).toBe(529)
    expect(r!.errorType).toBe('overloaded_error')
    expect(r!.message).toBe('Overloaded')
  })

  test('system api_error with 429 and no explicit message falls back to "Rate limited"', () => {
    const entry = {
      type: 'system',
      subtype: 'api_error',
      error: { status: 429 },
    }
    const r = classifyApiError(entry)
    expect(r).not.toBeNull()
    expect(r!.status).toBe(429)
    expect(r!.message).toBe('Rate limited')
  })

  test('system api_error with unknown status defaults to "HTTP <n>"', () => {
    const entry = {
      type: 'system',
      subtype: 'api_error',
      error: { status: 502 },
    }
    const r = classifyApiError(entry)
    expect(r!.message).toBe('HTTP 502')
  })

  test('assistant isApiErrorMessage with wrapped API Error JSON', () => {
    const entry = {
      type: 'assistant',
      isApiErrorMessage: true,
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'API Error: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_abc"}',
          },
        ],
      },
    }
    const r = classifyApiError(entry)
    expect(r).not.toBeNull()
    expect(r!.errorType).toBe('overloaded_error')
    expect(r!.message).toBe('Overloaded')
    expect(r!.status).toBeNull()
  })

  test('ordinary assistant messages are NOT classified as errors', () => {
    const entry = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] },
    }
    expect(classifyApiError(entry)).toBeNull()
  })

  test('user messages are NOT classified as errors', () => {
    expect(
      classifyApiError({
        type: 'user',
        message: { role: 'user', content: 'hi' },
      }),
    ).toBeNull()
  })

  test('system event unrelated to api errors returns null', () => {
    expect(
      classifyApiError({
        type: 'system',
        subtype: 'turn_duration',
        durationMs: 1000,
      }),
    ).toBeNull()
  })

  test('malformed synthetic assistant with garbage text still returns an error classification', () => {
    // isApiErrorMessage:true but text missing the JSON blob: fall back to defaults.
    const r = classifyApiError({
      type: 'assistant',
      isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'API Error: ' }] },
    })
    expect(r).not.toBeNull()
    expect(r!.errorType).toBe('api_error')
    expect(r!.message).toBe('API error')
  })
})
