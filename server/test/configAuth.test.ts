import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { DeviceAuthenticator } from '../src/http/deviceAuth.js'

function request(authorization?: string): IncomingMessage {
  return { headers: authorization ? { authorization } : {} } as IncomingMessage
}

describe('configuration and device authentication', () => {
  it('loads safe defaults and a unique device-token mapping', () => {
    const config = loadConfig({ DEVICE_AUTH_TOKENS: '{"pi-1":"secret-1","pi-2":"secret-2"}' })
    expect(config.deviceAuthConfigured).toBe(true)
    expect(config.deviceTokens.get('pi-1')).toBe('secret-1')
    expect(config.maxActiveSessions).toBe(8)
    expect(config.vitoFrameMs).toBe(100)
    expect(config.vitoDomain).toBe('MEETING')
    expect(config.vitoConnectTimeoutMs).toBe(10_000)
  })

  it('rejects duplicate tokens and unsafe timeout/frame settings', () => {
    expect(() => loadConfig({ DEVICE_AUTH_TOKENS: '{"pi-1":"same","pi-2":"same"}' })).toThrow(/unique/)
    expect(() => loadConfig({ VITO_FRAME_MS: '101' })).toThrow(/VITO_FRAME_MS/)
    expect(() => loadConfig({ VITO_CONNECT_TIMEOUT_MS: '99' })).toThrow(/VITO_CONNECT_TIMEOUT_MS/)
    expect(() => loadConfig({ REQUEST_TIMEOUT_MS: '1000', HEADERS_TIMEOUT_MS: '2000' })).toThrow(/HEADERS_TIMEOUT_MS/)
  })

  it('keeps ingestion unavailable when tokens are absent', () => {
    const auth = new DeviceAuthenticator(new Map(), false)
    expect(() => auth.authenticate(request('Bearer any'))).toThrow(expect.objectContaining({ status: 503 }))
  })

  it('accepts only a configured bearer and binds it to device_id', () => {
    const auth = new DeviceAuthenticator(new Map([['pi-1', 'secret']]))
    expect(() => auth.authenticate(request())).toThrow(expect.objectContaining({ status: 401 }))
    expect(() => auth.authenticate(request('Basic secret'))).toThrow(expect.objectContaining({ status: 401 }))
    expect(() => auth.authenticate(request('Bearer wrong'))).toThrow(expect.objectContaining({ status: 401 }))
    const principal = auth.authenticate(request('Bearer secret'))
    expect(principal).toEqual({ deviceId: 'pi-1' })
    expect(() => auth.assertDevice(principal, 'pi-2')).toThrow(expect.objectContaining({ status: 401 }))
  })
})
