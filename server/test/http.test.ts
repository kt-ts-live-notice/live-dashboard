import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { DeviceAuthenticator } from '../src/http/deviceAuth.js'
import { AudioChunkSessionManager } from '../src/sessions/audioChunkSessionManager.js'
import { InMemoryResultStore } from '../src/storage/resultStore.js'
import type { AudioStream } from '../src/sessions/types.js'
import { makeWav } from './helpers/wav.js'

const openServers: ReturnType<typeof createServer>[] = []
const openManagers: AudioChunkSessionManager[] = []
afterEach(async () => {
  await Promise.all(openManagers.splice(0).map((manager) => manager.shutdown()))
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

function form(overrides: Record<string, string | Blob | undefined> = {}): FormData {
  const data = new FormData()
  const values: Record<string, string | Blob | undefined> = {
    session_id: 'session-1', chunk_index: '0', is_final: 'true', device_id: 'pi-1',
    recorded_at: '2026-08-03T01:02:03Z', audio: new Blob([Uint8Array.from(makeWav({ samples: 8_000 }))], { type: 'audio/wav' }), ...overrides,
  }
  for (const [name, value] of Object.entries(values)) if (value !== undefined) {
    if (value instanceof Blob) data.append(name, value, 'chunk.wav')
    else data.append(name, value)
  }
  return data
}

async function setup(options: { configuredAuth?: boolean; connectFails?: boolean; maxActiveSessions?: number } = {}) {
  const stream: AudioStream = { sendAudio: async () => undefined, end: async () => undefined, finish: async () => new Promise(() => undefined), close: () => undefined }
  const manager = new AudioChunkSessionManager({
    maxActiveSessions: options.maxActiveSessions ?? 8, inactivityMs: 15_000, completedTtlMs: 60_000, queueMaxMs: 8_000,
    maxSessionChunks: 1_800, maxCompletedReceipts: 1_024, frameMs: 100, finalWaitMs: 10_000, classifyTimeoutMs: 15_000,
    connectTimeoutMs: 10_000,
  }, {
    streamFactory: { create: async () => { if (options.connectFails) throw new Error('connect'); return stream } },
    classifier: vi.fn(), resultStore: new InMemoryResultStore(), broadcast: vi.fn(), sleep: async () => undefined,
  })
  openManagers.push(manager)
  const tokens = options.configuredAuth === false ? new Map<string, string>() : new Map([['pi-1', '0123456789abcdef']])
  const samplePlay = vi.fn(() => true)
  const sampleAudio = Buffer.from(makeWav({ samples: 16 }))
  const app = createApp({
    authenticator: new DeviceAuthenticator(tokens, options.configuredAuth !== false), sessionManager: manager,
    samples: {
      list: async () => ['positive'],
      read: async (name) => name === 'positive' ? sampleAudio : null,
      current: () => null,
      play: samplePlay,
    },
  })
  const server = createServer(app)
  openServers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing address')
  return { base: `http://127.0.0.1:${address.port}`, manager, samplePlay }
}

describe('audio chunk HTTP integration', () => {
  it('authenticates and returns the exact 202 contract', async () => {
    const { base } = await setup()
    const response = await fetch(`${base}/api/v1/audio-chunks`, { method: 'POST', headers: { Authorization: 'Bearer 0123456789abcdef' }, body: form() })
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ session_id: 'session-1', accepted_chunk_index: 0, next_chunk_index: 1, is_duplicate: false, finalized: true })
  })

  it('acknowledges an exact final retry and rejects a conflicting retry', async () => {
    const { base } = await setup()
    const request = () => fetch(`${base}/api/v1/audio-chunks`, {
      method: 'POST', headers: { Authorization: 'Bearer 0123456789abcdef' }, body: form(),
    })
    expect((await request()).status).toBe(202)
    const duplicate = await request()
    expect(duplicate.status).toBe(202)
    expect(await duplicate.json()).toMatchObject({ is_duplicate: true, finalized: true })

    const conflict = await fetch(`${base}/api/v1/audio-chunks`, {
      method: 'POST', headers: { Authorization: 'Bearer 0123456789abcdef' },
      body: form({ recorded_at: '2026-08-03T01:02:04Z' }),
    })
    expect(conflict.status).toBe(409)
    expect(conflict.headers.get('content-type')).toContain('application/problem+json')
  })

  it.each([
    ['missing auth', {}, form(), 401],
    ['wrong media', { Authorization: 'Bearer 0123456789abcdef', 'Content-Type': 'application/json' }, '{}', 415],
    ['device mismatch', { Authorization: 'Bearer 0123456789abcdef' }, form({ device_id: 'pi-2' }), 401],
    ['bad timestamp', { Authorization: 'Bearer 0123456789abcdef' }, form({ recorded_at: 'yesterday' }), 400],
    ['impossible timestamp', { Authorization: 'Bearer 0123456789abcdef' }, form({ recorded_at: '2026-02-30T01:02:03Z' }), 400],
    ['bad wav duration', { Authorization: 'Bearer 0123456789abcdef' }, form({ is_final: 'false' }), 422],
  ])('maps %s to problem JSON', async (_name, headers, body, status) => {
    const { base } = await setup()
    const response = await fetch(`${base}/api/v1/audio-chunks`, { method: 'POST', headers, body } as RequestInit)
    expect(response.status).toBe(status)
    expect(response.headers.get('content-type')).toContain('application/problem+json')
    expect(await response.json()).toMatchObject({ status })
  })

  it('preserves sample listing and play routes without bearer auth', async () => {
    const { base, samplePlay } = await setup()
    expect(await (await fetch(`${base}/api/samples`)).json()).toEqual({ samples: ['positive'], playing: null })
    expect((await fetch(`${base}/api/play/positive?station_id=station-pi-01`, { method: 'POST' })).status).toBe(200)
    expect(samplePlay).toHaveBeenCalledWith('positive', 'station-pi-01')
    expect((await fetch(`${base}/api/play/positive?station_id=..%2Fother`, { method: 'POST' })).status).toBe(400)
  })

  it('serves playable WAV sample bytes without exposing arbitrary paths', async () => {
    const { base } = await setup()
    const response = await fetch(`${base}/api/samples/positive/audio`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('audio/wav')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('accept-ranges')).toBe('bytes')
    expect(Buffer.from(await response.arrayBuffer()).subarray(0, 4).toString('ascii')).toBe('RIFF')
    const partial = await fetch(`${base}/api/samples/positive/audio`, { headers: { Range: 'bytes=0-15' } })
    expect(partial.status).toBe(206)
    expect(partial.headers.get('content-range')).toMatch(/^bytes 0-15\//)
    expect(Buffer.from(await partial.arrayBuffer())).toHaveLength(16)
    const head = await fetch(`${base}/api/samples/positive/audio`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(makeWav({ samples: 16 }).length))
    expect((await fetch(`${base}/api/samples/positive/audio`, { headers: { Range: 'bytes=999999-' } })).status).toBe(416)
    expect((await fetch(`${base}/api/samples/missing/audio`)).status).toBe(404)
    expect((await fetch(`${base}/api/samples/..%2Fsecret/audio`)).status).toBe(404)
  })

  it('maps VITO initialization failure to 502 and missing device config to 503', async () => {
    const unavailable = await setup({ connectFails: true })
    const failed = await fetch(`${unavailable.base}/api/v1/audio-chunks`, { method: 'POST', headers: { Authorization: 'Bearer 0123456789abcdef' }, body: form() })
    expect(failed.status).toBe(502)
    const unconfigured = await setup({ configuredAuth: false })
    const disabled = await fetch(`${unconfigured.base}/api/v1/audio-chunks`, { method: 'POST', headers: { Authorization: 'Bearer anything' }, body: form() })
    expect(disabled.status).toBe(503)
  })

  it('rejects oversized files while streaming with 413 and no session creation', async () => {
    const { base, manager } = await setup()
    const oversized = new Blob([new Uint8Array(128 * 1024 + 1)], { type: 'audio/wav' })
    const response = await fetch(`${base}/api/v1/audio-chunks`, {
      method: 'POST', headers: { Authorization: 'Bearer 0123456789abcdef' }, body: form({ audio: oversized }),
    })
    expect(response.status).toBe(413)
    expect(manager.activeSessionCount).toBe(0)
  })

  it('returns 409 for an out-of-order chunk and 429 at the active-session cap', async () => {
    const { base } = await setup({ maxActiveSessions: 1 })
    const fullWav = new Blob([Uint8Array.from(makeWav())], { type: 'audio/wav' })
    const first = await fetch(`${base}/api/v1/audio-chunks`, {
      method: 'POST', headers: { Authorization: 'Bearer 0123456789abcdef' }, body: form({ is_final: 'false', audio: fullWav }),
    })
    expect(first.status).toBe(202)
    const gap = await fetch(`${base}/api/v1/audio-chunks`, {
      method: 'POST', headers: { Authorization: 'Bearer 0123456789abcdef' }, body: form({ chunk_index: '2', is_final: 'false', audio: fullWav }),
    })
    expect(gap.status).toBe(409)
    expect(await gap.json()).toMatchObject({ expected_chunk_index: 1 })
    const capped = await fetch(`${base}/api/v1/audio-chunks`, {
      method: 'POST', headers: { Authorization: 'Bearer 0123456789abcdef' }, body: form({ session_id: 'session-2' }),
    })
    expect(capped.status).toBe(429)
  })
})
