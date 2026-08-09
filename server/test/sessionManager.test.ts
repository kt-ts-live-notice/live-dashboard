import { describe, expect, it, vi } from 'vitest'
import { AudioChunkSessionManager } from '../src/sessions/audioChunkSessionManager.js'
import { InMemoryResultStore } from '../src/storage/resultStore.js'
import type { AudioStream, Classifier, StreamHandlers } from '../src/sessions/types.js'
import { makeWav } from './helpers/wav.js'

class FakeStream implements AudioStream {
  sent: Buffer[] = []
  ended = 0
  closed = 0
  private resolve!: () => void
  completion = new Promise<void>((resolve) => { this.resolve = resolve })
  constructor(readonly handlers: StreamHandlers) {}
  async sendAudio(chunk: Buffer): Promise<void> { this.sent.push(Buffer.from(chunk)) }
  async end(_signal?: AbortSignal): Promise<void> { this.ended += 1 }
  finish(): Promise<void> { return this.completion }
  close(): void { this.closed += 1 }
  complete(): void { this.resolve() }
}

function setup(
  overrides: Record<string, number> = {},
  custom: {
    create?: (handlers: StreamHandlers, signal?: AbortSignal) => Promise<AudioStream>
    classifier?: Classifier
  } = {},
) {
  const streams: FakeStream[] = []
  const events: Record<string, unknown>[] = []
  const defaultClassifier: Classifier = async () => ({
    is_announcement: true, category: '일반 안내', label: '일반 안내', severity: '일반', simplified: '안내',
  })
  const classifier = vi.fn(custom.classifier ?? defaultClassifier)
  const store = new InMemoryResultStore()
  const manager = new AudioChunkSessionManager({
    maxActiveSessions: 8, inactivityMs: 15_000, completedTtlMs: 60_000, queueMaxMs: 8_000,
    maxSessionChunks: 1_800, maxCompletedReceipts: 1_024, frameMs: 100, connectTimeoutMs: 10_000, finalWaitMs: 10_000,
    classifyTimeoutMs: 15_000, ...overrides,
  }, {
    streamFactory: { async create(handlers, signal) {
      if (custom.create) return custom.create(handlers, signal)
      const stream = new FakeStream(handlers); streams.push(stream); return stream
    } },
    classifier,
    resultStore: store,
    broadcast: (event) => { events.push(event) },
    sleep: async () => undefined,
    logger: { info: vi.fn(), error: vi.fn() },
  })
  return { manager, streams, events, classifier, store }
}

function chunk(index: number, options: { device?: string; session?: string; final?: boolean; marker?: number } = {}) {
  const pcm = Buffer.alloc(index === 0 && options.final ? 16_000 : 64_000, options.marker ?? index)
  return {
    deviceId: options.device ?? 'pi-1', sessionId: options.session ?? 'broadcast-1', chunkIndex: index,
    isFinal: options.final ?? false, recordedAt: `2026-08-03T00:00:0${index}Z`, receivedAt: index * 2_000,
    rawWav: makeWav({ pcm }), pcm,
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 200; index++) await Promise.resolve()
}

describe('AudioChunkSessionManager', () => {
  it('accepts ordered chunks, isolates devices, and makes exact retries idempotent', async () => {
    const { manager, streams } = setup()
    expect(await manager.accept(chunk(0))).toMatchObject({ next_chunk_index: 1, is_duplicate: false })
    expect(await manager.accept(chunk(0))).toMatchObject({ next_chunk_index: 1, is_duplicate: true })
    await manager.accept(chunk(0, { device: 'pi-2' }))
    expect(streams).toHaveLength(2)
    await settle()
    expect(Buffer.concat(streams[0].sent)).toEqual(chunk(0).pcm)
  })

  it('rejects gaps and conflicting retries without advancing', async () => {
    const { manager } = setup()
    await manager.accept(chunk(0))
    await expect(manager.accept(chunk(2))).rejects.toMatchObject({ status: 409, extensions: { expected_chunk_index: 1 } })
    await expect(manager.accept(chunk(0, { marker: 9 }))).rejects.toMatchObject({ status: 409 })
    expect((await manager.accept(chunk(1))).next_chunk_index).toBe(2)
  })

  it('serializes simultaneous chunk zero and creates one stream', async () => {
    const { manager, streams } = setup()
    const [first, second] = await Promise.all([manager.accept(chunk(0)), manager.accept(chunk(0))])
    expect([first.is_duplicate, second.is_duplicate].sort()).toEqual([false, true])
    expect(streams).toHaveLength(1)
  })

  it('drains, sends one EOS, aggregates ordered deduplicated finals, stores, then announces once', async () => {
    const { manager, streams, classifier, events, store } = setup()
    await manager.accept(chunk(0))
    await manager.accept(chunk(1, { final: true }))
    await settle()
    streams[0].handlers.onFinal('둘', 2)
    streams[0].handlers.onFinal('하나', 1)
    streams[0].handlers.onFinal('중복', 1)
    streams[0].complete()
    await settle()
    expect(streams[0].ended).toBe(1)
    expect(classifier).toHaveBeenCalledTimes(1)
    expect(classifier.mock.calls[0][0]).toBe('하나 둘')
    expect(store.get('4:pi-111:broadcast-1')?.transcript).toBe('하나 둘')
    expect(events.filter((event) => event.type === 'announcement')).toEqual([
      expect.objectContaining({ category: '일반 안내', label: '일반 안내', severity: '일반' }),
    ])
    expect((await manager.accept(chunk(1, { final: true }))).is_duplicate).toBe(true)
    expect(streams).toHaveLength(1)
  })

  it('enforces active and queue capacity before mutation', async () => {
    const one = setup({ maxActiveSessions: 1 })
    await one.manager.accept(chunk(0))
    await expect(one.manager.accept(chunk(0, { session: 'other' }))).rejects.toMatchObject({ status: 429 })
    const small = setup({ queueMaxMs: 1_000 })
    await expect(small.manager.accept(chunk(0))).rejects.toMatchObject({ status: 429 })
    expect(small.streams).toHaveLength(0)
  })

  it('times out an incomplete session without classification or a card', async () => {
    vi.useFakeTimers()
    try {
      const { manager, streams, classifier, events } = setup({ inactivityMs: 15_000 })
      await manager.accept(chunk(0))
      await settle()
      await vi.advanceTimersByTimeAsync(15_000)
      await settle()
      expect(streams[0].closed).toBe(1)
      expect(classifier).not.toHaveBeenCalled()
      expect(events.filter((event) => event.type === 'announcement')).toHaveLength(0)
      expect(events).toContainEqual(expect.objectContaining({ type: 'session-error', code: 'session-inactivity-timeout' }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats EOS completion timeout as terminal and does not classify partial finals', async () => {
    vi.useFakeTimers()
    try {
      const { manager, streams, classifier, events } = setup({ finalWaitMs: 1_000 })
      await manager.accept(chunk(0, { final: true }))
      await settle()
      expect(streams[0].ended).toBe(1)
      streams[0].handlers.onFinal('부분', 1)
      await vi.advanceTimersByTimeAsync(1_000)
      await settle()
      expect(classifier).not.toHaveBeenCalled()
      expect(events).toContainEqual(expect.objectContaining({ type: 'session-error', code: 'vito-final-timeout' }))
      expect(events.filter((event) => event.type === 'announcement')).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds classification, releases capacity, and ignores callbacks after terminal cleanup', async () => {
    vi.useFakeTimers()
    try {
      const neverClassifies: Classifier = async () => new Promise(() => undefined)
      const { manager, streams, classifier, events } = setup(
        { classifyTimeoutMs: 1_000, maxActiveSessions: 1 },
        { classifier: neverClassifies },
      )
      await manager.accept(chunk(0, { final: true }))
      await settle()
      streams[0].complete()
      await settle()
      expect(classifier).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1_000)
      await settle()
      expect(manager.activeSessionCount).toBe(0)
      expect(events).toContainEqual(expect.objectContaining({ type: 'session-error', code: 'classify-timeout' }))
      expect(events.filter((event) => event.type === 'announcement')).toHaveLength(0)

      const finalEvents = events.filter((event) => event.type === 'stt-final').length
      streams[0].handlers.onFinal('too late', 99)
      await settle()
      expect(events.filter((event) => event.type === 'stt-final')).toHaveLength(finalEvents)
      expect((await manager.accept(chunk(0, { final: true }))).is_duplicate).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds a never-resolving EOS send, closes, tombstones, and releases capacity', async () => {
    vi.useFakeTimers()
    try {
      const { manager, streams, classifier, events } = setup({ finalWaitMs: 1_000 })
      const accepted = await manager.accept(chunk(0, { final: true }))
      streams[0].end = async () => new Promise<void>(() => undefined)
      await settle()
      await vi.advanceTimersByTimeAsync(1_000)
      await settle()
      expect(accepted.finalized).toBe(true)
      expect(classifier).not.toHaveBeenCalled()
      expect(streams[0].closed).toBe(1)
      expect(manager.activeSessionCount).toBe(0)
      expect(events).toContainEqual(expect.objectContaining({ type: 'session-error', code: 'vito-eos-timeout' }))
      expect((await manager.accept(chunk(0, { final: true }))).is_duplicate).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('times out a never-resolving initialization with 502 and rolls back its reservation', async () => {
    vi.useFakeTimers()
    try {
      const { manager } = setup({ connectTimeoutMs: 1_000 }, { create: async () => new Promise(() => undefined) })
      const acceptance = manager.accept(chunk(0))
      const rejected = expect(acceptance).rejects.toMatchObject({ status: 502 })
      await vi.advanceTimersByTimeAsync(1_000)
      await rejected
      expect(manager.activeSessionCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts pending initialization before waiting for locks during shutdown', async () => {
    let initializationSignal: AbortSignal | undefined
    const { manager } = setup({}, { create: async (_handlers, signal) => {
      initializationSignal = signal
      return new Promise<AudioStream>(() => undefined)
    } })
    const acceptance = manager.accept(chunk(0))
    await settle()
    const closing = manager.shutdown()
    await expect(acceptance).rejects.toMatchObject({ status: 503 })
    await closing
    expect(initializationSignal?.aborted).toBe(true)
    expect(manager.activeSessionCount).toBe(0)
  })

  it('stores and emits a filtered aggregate without an announcement', async () => {
    const { manager, streams, classifier, events } = setup()
    classifier.mockResolvedValueOnce({
      is_announcement: false, category: '일반 안내', label: '', severity: '일반', simplified: '',
    })
    await manager.accept(chunk(0, { final: true }))
    await settle()
    streams[0].handlers.onFinal('승객 대화', 1)
    streams[0].complete()
    await settle()
    expect(events.filter((event) => event.type === 'filtered')).toHaveLength(1)
    expect(events.filter((event) => event.type === 'announcement')).toHaveLength(0)
  })

  it('enforces the cumulative session chunk limit before mutation', async () => {
    const { manager } = setup({ maxSessionChunks: 1 })
    await manager.accept(chunk(0))
    await expect(manager.accept(chunk(1))).rejects.toMatchObject({ status: 413 })
  })

  it('fails visibly after a send error and never classifies', async () => {
    const { manager, streams, classifier, events } = setup()
    const accepted = await manager.accept(chunk(0))
    streams[0].sendAudio = async () => { throw new Error('send failed') }
    await manager.accept(chunk(1, { final: true }))
    await settle()
    expect(accepted.is_duplicate).toBe(false)
    expect(classifier).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === 'session-error')).toBe(true)
    expect((await manager.accept(chunk(0))).is_duplicate).toBe(true)
  })
})
