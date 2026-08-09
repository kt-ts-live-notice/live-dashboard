import { createHash } from 'node:crypto'
import { AppError } from '../http/problem.js'
import type { ResultStore, SessionResult } from '../storage/resultStore.js'
import type {
  AudioChunkInput, AudioStream, Broadcaster, ChunkAcknowledgement, Classifier, SessionManagerOptions, StreamFactory,
} from './types.js'

type TerminalStatus = 'completed' | 'failed' | 'timed-out'
type Lifecycle = 'ACTIVE' | 'SEALED' | 'FINISHING' | 'CLASSIFYING' | TerminalStatus

interface Receipt { fingerprint: string; receivedAt: number; recordedAt: string }
interface CompletedReceipt {
  fingerprints: Map<number, string>
  nextIndex: number
  sealed: boolean
  status: TerminalStatus
  expiresAt: number
}
interface QueueItem { pcm: Buffer; offset: number }
interface ActiveSession {
  key: string
  deviceId: string
  sessionId: string
  stream: AudioStream
  lifecycle: Lifecycle
  expectedIndex: number
  receipts: Map<number, Receipt>
  queue: QueueItem[]
  reservedBytes: number
  finals: Map<number, string>
  firstRecordedAt: string
  firstReceivedAt: number
  finalRecordedAt?: string
  finalReceivedAt?: number
  inactivityTimer?: ReturnType<typeof setTimeout>
  deadline: number
  timerGeneration: number
  abort: AbortController
  pump?: Promise<void>
  finalization?: Promise<void>
  nextFrameAt: number
  frameNumber: number
}

export interface SessionManagerDependencies {
  streamFactory: StreamFactory
  classifier: Classifier
  resultStore: ResultStore
  broadcast: Broadcaster
  now?: () => number
  monotonicNow?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  logger?: Pick<Console, 'info' | 'error'>
}

function keyOf(deviceId: string, sessionId: string): string {
  return `${deviceId.length}:${deviceId}${sessionId.length}:${sessionId}`
}

function fingerprint(input: AudioChunkInput): string {
  const hash = createHash('sha256')
  const add = (value: string | Buffer) => {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value)
    const length = Buffer.allocUnsafe(8)
    length.writeBigUInt64BE(BigInt(data.length))
    hash.update(length).update(data)
  }
  add(input.rawWav)
  add(input.deviceId)
  add(input.sessionId)
  add(String(input.chunkIndex))
  add(input.isFinal ? 'true' : 'false')
  add(input.recordedAt)
  return hash.digest('hex')
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      reject(signal.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
}

export class AudioChunkSessionManager {
  private readonly active = new Map<string, ActiveSession>()
  private readonly completed = new Map<string, CompletedReceipt>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly initializing = new Map<string, AbortController>()
  private readonly now: () => number
  private readonly monotonicNow: () => number
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout
  private readonly logger: Pick<Console, 'info' | 'error'>
  private accepting = true

  constructor(private readonly options: SessionManagerOptions, private readonly deps: SessionManagerDependencies) {
    if (options.frameMs < 50 || options.frameMs > 100) throw new Error('frameMs must be between 50 and 100')
    this.now = deps.now ?? Date.now
    this.monotonicNow = deps.monotonicNow ?? this.now
    this.sleep = deps.sleep ?? defaultSleep
    this.setTimer = deps.setTimer ?? setTimeout
    this.clearTimer = deps.clearTimer ?? clearTimeout
    this.logger = deps.logger ?? console
  }

  async accept(input: AudioChunkInput): Promise<ChunkAcknowledgement> {
    if (!this.accepting) throw new AppError(503, 'ingestion-shutting-down', 'Audio ingestion is shutting down.')
    const key = keyOf(input.deviceId, input.sessionId)
    return this.withKeyLock(key, async () => {
      this.evictCompleted()
      if (!this.accepting) throw new AppError(503, 'ingestion-shutting-down', 'Audio ingestion is shutting down.')
      const digest = fingerprint(input)
      const tombstone = this.completed.get(key)
      if (tombstone) return this.replayCompleted(input, digest, tombstone)

      let session = this.active.get(key)
      if (!session) {
        if (input.chunkIndex !== 0) throw this.orderError(0)
        if (input.chunkIndex >= this.options.maxSessionChunks) throw new AppError(413, 'session-chunk-limit', 'The session has reached its maximum chunk count.')
        const maxBytes = Math.floor(16_000 * 2 * this.options.queueMaxMs / 1_000)
        if (input.pcm.length > maxBytes) {
          throw new AppError(429, 'session-queue-capacity', 'The session audio queue is full.', {}, { 'Retry-After': '1' })
        }
        if (this.active.size + this.initializing.size >= this.options.maxActiveSessions) {
          throw new AppError(429, 'active-session-capacity', 'The active audio session limit has been reached.', {}, { 'Retry-After': '1' })
        }
        const initialization = new AbortController()
        this.initializing.set(key, initialization)
        try {
          let owned: ActiveSession | undefined
          const handlers = {
            onInterim: (text: string, seq?: number) => { if (owned) this.onInterim(owned, text, seq) },
            onFinal: (text: string, seq: number) => { if (owned) this.onFinal(owned, text, seq) },
            onError: (error: Error) => { if (owned) void this.failOwned(owned, 'vito-stream-error', error) },
            onClose: () => undefined,
          }
          let stream: AudioStream
          try {
            const creation = this.deps.streamFactory.create(handlers, initialization.signal)
            void creation.then((created) => {
              if (initialization.signal.aborted) {
                try { created.close() } catch { /* late initialization rollback */ }
              }
            }).catch(() => undefined)
            stream = await this.withAbortTimeout(creation, this.options.connectTimeoutMs, 'vito-connect-timeout', initialization)
          } catch {
            if (!this.accepting) throw new AppError(503, 'ingestion-shutting-down', 'Audio ingestion is shutting down.')
            throw new AppError(502, 'vito-connect-failed', 'The speech service connection could not be established.')
          }
          if (!this.accepting) {
            try { stream.close() } catch { /* connection rollback */ }
            throw new AppError(503, 'ingestion-shutting-down', 'Audio ingestion is shutting down.')
          }
          session = {
            key, deviceId: input.deviceId, sessionId: input.sessionId, stream, lifecycle: 'ACTIVE', expectedIndex: 0,
            receipts: new Map(), queue: [], reservedBytes: 0, finals: new Map(), firstRecordedAt: input.recordedAt,
            firstReceivedAt: input.receivedAt, deadline: 0, timerGeneration: 0, abort: new AbortController(),
            nextFrameAt: this.monotonicNow(), frameNumber: 0,
          }
          owned = session
          this.active.set(key, session)
        } finally {
          this.initializing.delete(key)
        }
      }

      return this.acceptIntoSession(session, input, digest)
    })
  }

  private acceptIntoSession(session: ActiveSession, input: AudioChunkInput, digest: string): ChunkAcknowledgement {
    if (input.chunkIndex < session.expectedIndex) {
      const receipt = session.receipts.get(input.chunkIndex)
      if (receipt?.fingerprint === digest) return this.ack(input, session.expectedIndex, true, session.lifecycle !== 'ACTIVE')
      throw new AppError(409, 'conflicting-retry', 'A different request was already accepted for this chunk index.')
    }
    if (input.chunkIndex > session.expectedIndex) throw this.orderError(session.expectedIndex)
    if (session.lifecycle !== 'ACTIVE') throw new AppError(409, 'session-sealed', 'The session is already sealed.')
    if (input.chunkIndex >= this.options.maxSessionChunks) throw new AppError(413, 'session-chunk-limit', 'The session has reached its maximum chunk count.')
    const maxBytes = Math.floor(16_000 * 2 * this.options.queueMaxMs / 1_000)
    if (session.reservedBytes + input.pcm.length > maxBytes) {
      throw new AppError(429, 'session-queue-capacity', 'The session audio queue is full.', {}, { 'Retry-After': '1' })
    }

    session.receipts.set(input.chunkIndex, { fingerprint: digest, receivedAt: input.receivedAt, recordedAt: input.recordedAt })
    session.queue.push({ pcm: Buffer.from(input.pcm), offset: 0 })
    session.reservedBytes += input.pcm.length
    session.expectedIndex += 1
    if (input.isFinal) {
      session.lifecycle = 'SEALED'
      session.finalRecordedAt = input.recordedAt
      session.finalReceivedAt = input.receivedAt
      this.cancelInactivity(session)
    } else {
      this.armInactivity(session)
    }
    this.startPump(session)
    return this.ack(input, session.expectedIndex, false, input.isFinal)
  }

  private startPump(session: ActiveSession): void {
    if (session.pump) return
    session.pump = this.pump(session).catch((error) => this.failSession(session, 'vito-send-failed', error)).finally(() => {
      session.pump = undefined
      if (this.active.get(session.key) === session && session.queue.length > 0 && !session.abort.signal.aborted) this.startPump(session)
    })
  }

  private async pump(session: ActiveSession): Promise<void> {
    const frameBytes = Math.floor(16_000 * 2 * this.options.frameMs / 1_000)
    while (session.queue.length > 0 && !session.abort.signal.aborted) {
      const item = session.queue[0]
      const frame = item.pcm.subarray(item.offset, Math.min(item.offset + frameBytes, item.pcm.length))
      const current = this.monotonicNow()
      if (session.frameNumber === 0 || session.nextFrameAt < current - this.options.frameMs) session.nextFrameAt = current
      const wait = session.nextFrameAt - current
      if (wait > 0) await this.sleep(wait, session.abort.signal)
      await session.stream.sendAudio(frame, session.abort.signal)
      item.offset += frame.length
      session.reservedBytes -= frame.length
      session.frameNumber += 1
      session.nextFrameAt += frame.length / 32
      if (item.offset >= item.pcm.length) session.queue.shift()
    }
    if (session.lifecycle === 'SEALED' && session.reservedBytes === 0) this.startFinalization(session)
  }

  private startFinalization(session: ActiveSession): void {
    if (session.finalization || session.abort.signal.aborted) return
    session.finalization = this.finalize(session).catch((error) => {
      const message = error instanceof Error ? error.message : ''
      const code = message === 'vito-eos-timeout' || message === 'vito-final-timeout' || message === 'classify-timeout'
        ? message : 'session-finalization-failed'
      return this.failSession(session, code, error)
    })
  }

  private async finalize(session: ActiveSession): Promise<void> {
    session.lifecycle = 'FINISHING'
    await this.withTimeout(
      session.stream.end(session.abort.signal), this.options.finalWaitMs, 'vito-eos-timeout', session.abort.signal,
    )
    await this.withTimeout(session.stream.finish(), this.options.finalWaitMs, 'vito-final-timeout', session.abort.signal)
    if (session.abort.signal.aborted) return
    const transcript = [...session.finals.entries()].sort(([a], [b]) => a - b).map(([, text]) => text).join(' ')
    session.lifecycle = 'CLASSIFYING'
    const classification = await this.withTimeout(
      this.deps.classifier(transcript, [], session.abort.signal), this.options.classifyTimeoutMs, 'classify-timeout', session.abort.signal,
    )
    if (session.abort.signal.aborted) return
    const completedAt = this.now()
    const result: SessionResult = {
      deviceId: session.deviceId, sessionId: session.sessionId, firstRecordedAt: session.firstRecordedAt,
      finalRecordedAt: session.finalRecordedAt!, firstReceivedAt: session.firstReceivedAt,
      finalReceivedAt: session.finalReceivedAt!, transcript, classification,
      outcome: classification.is_announcement ? 'announcement' : 'filtered', completedAt,
    }
    const inserted = await this.deps.resultStore.putIfAbsent(session.key, result)
    if (!inserted) throw new Error('duplicate result key')
    if (session.abort.signal.aborted) return
    if (classification.is_announcement) {
      const cardAt = this.now()
      const latencyMs = cardAt - session.finalReceivedAt!
      this.logger.info(JSON.stringify({ metric: 'final_to_card_ms', device_id: session.deviceId, session_id: session.sessionId, value: latencyMs }))
      await this.deps.broadcast({
        type: 'announcement', device_id: session.deviceId, session_id: session.sessionId, original: transcript,
        simplified: classification.simplified, category: classification.category, label: classification.label,
        severity: classification.severity,
        latencyMs, ts: cardAt,
      })
    } else {
      await this.deps.broadcast({ type: 'filtered', device_id: session.deviceId, session_id: session.sessionId, original: transcript, text: transcript, ts: completedAt })
    }
    await this.completeSession(session, 'completed')
  }

  private onInterim(session: ActiveSession, text: string, seq?: number): void {
    if (this.active.get(session.key) !== session || this.isTerminal(session.lifecycle)) return
    void Promise.resolve(this.deps.broadcast({ type: 'stt-interim', device_id: session.deviceId, session_id: session.sessionId, text, ...(seq === undefined ? {} : { seq }), ts: this.now() })).catch(() => undefined)
  }

  private onFinal(session: ActiveSession, text: string, seq: number): void {
    if (this.active.get(session.key) !== session || this.isTerminal(session.lifecycle)) return
    if (!session.finals.has(seq)) session.finals.set(seq, text)
    void Promise.resolve(this.deps.broadcast({ type: 'stt-final', device_id: session.deviceId, session_id: session.sessionId, text, seq, ts: this.now() })).catch(() => undefined)
  }

  private armInactivity(session: ActiveSession): void {
    this.cancelInactivity(session)
    session.timerGeneration += 1
    const generation = session.timerGeneration
    session.deadline = this.now() + this.options.inactivityMs
    session.inactivityTimer = this.setTimer(() => {
      void this.withKeyLock(session.key, async () => {
        if (this.active.get(session.key) !== session || session.lifecycle !== 'ACTIVE' || generation !== session.timerGeneration) return
        const remaining = session.deadline - this.now()
        if (remaining > 0) {
          session.inactivityTimer = this.setTimer(() => { void this.timeoutByKey(session.key, generation) }, remaining)
          return
        }
        await this.failSession(session, 'session-inactivity-timeout', undefined, 'timed-out')
      })
    }, this.options.inactivityMs)
  }

  private async timeoutByKey(key: string, generation: number): Promise<void> {
    await this.withKeyLock(key, async () => {
      const session = this.active.get(key)
      if (session && session.lifecycle === 'ACTIVE' && session.timerGeneration === generation) await this.failSession(session, 'session-inactivity-timeout', undefined, 'timed-out')
    })
  }

  private cancelInactivity(session: ActiveSession): void {
    if (session.inactivityTimer !== undefined) this.clearTimer(session.inactivityTimer)
    session.inactivityTimer = undefined
  }

  private async failOwned(session: ActiveSession, code: string, error: unknown): Promise<void> {
    await this.withKeyLock(session.key, async () => {
      if (this.active.get(session.key) === session) await this.failSession(session, code, error)
    })
  }

  private async failSession(session: ActiveSession, code: string, error?: unknown, status: TerminalStatus = 'failed'): Promise<void> {
    if (this.isTerminal(session.lifecycle)) return
    session.lifecycle = status
    if (error && !session.abort.signal.aborted) this.logger.error(`[${code}] ${error instanceof Error ? error.message : String(error)}`)
    await Promise.resolve(this.deps.broadcast({ type: 'session-error', device_id: session.deviceId, session_id: session.sessionId, code, ts: this.now() })).catch(() => undefined)
    await this.completeSession(session, status)
  }

  private async completeSession(session: ActiveSession, status: TerminalStatus): Promise<void> {
    if (this.active.get(session.key) !== session) return
    session.lifecycle = status
    this.cancelInactivity(session)
    session.abort.abort(new Error(status))
    session.queue.length = 0
    session.reservedBytes = 0
    try { session.stream.close() } catch { /* terminal cleanup is best-effort */ }
    this.active.delete(session.key)
    this.completed.set(session.key, {
      fingerprints: new Map([...session.receipts].map(([index, value]) => [index, value.fingerprint])),
      nextIndex: session.expectedIndex, sealed: session.finalRecordedAt !== undefined, status,
      expiresAt: this.now() + this.options.completedTtlMs,
    })
    this.evictCompleted()
  }

  private replayCompleted(input: AudioChunkInput, digest: string, tombstone: CompletedReceipt): ChunkAcknowledgement {
    const existing = tombstone.fingerprints.get(input.chunkIndex)
    if (existing === digest) return this.ack(input, tombstone.nextIndex, true, tombstone.sealed)
    throw new AppError(409, 'completed-session-conflict', 'The completed session receipt does not match this request.')
  }

  private evictCompleted(): void {
    const now = this.now()
    for (const [key, receipt] of this.completed) if (receipt.expiresAt <= now) this.completed.delete(key)
    while (this.completed.size > this.options.maxCompletedReceipts) {
      let oldestKey: string | undefined
      let oldest = Infinity
      for (const [key, receipt] of this.completed) if (receipt.expiresAt < oldest) { oldest = receipt.expiresAt; oldestKey = key }
      if (oldestKey === undefined) break
      this.completed.delete(oldestKey)
    }
  }

  private async withKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.catch(() => undefined).then(() => current)
    this.locks.set(key, tail)
    await previous.catch(() => undefined)
    try { return await operation() } finally {
      release()
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number, code: string, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        this.clearTimer(timer)
        signal.removeEventListener('abort', abort)
      }
      const succeed = (value: T) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const timer = this.setTimer(() => fail(new Error(code)), ms)
      const abort = () => fail(signal.reason ?? new Error('aborted'))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      promise.then(succeed, fail)
    })
  }

  private async withAbortTimeout<T>(promise: Promise<T>, ms: number, code: string, controller: AbortController): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        this.clearTimer(timer)
        controller.signal.removeEventListener('abort', abort)
      }
      const succeed = (value: T) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const abort = () => fail(controller.signal.reason ?? new Error(code))
      const timer = this.setTimer(() => controller.abort(new Error(code)), ms)
      controller.signal.addEventListener('abort', abort, { once: true })
      if (controller.signal.aborted) abort()
      promise.then(succeed, fail)
    })
  }

  private ack(input: AudioChunkInput, next: number, duplicate: boolean, finalized: boolean): ChunkAcknowledgement {
    return { session_id: input.sessionId, accepted_chunk_index: input.chunkIndex, next_chunk_index: next, is_duplicate: duplicate, finalized }
  }

  private orderError(expected: number): AppError {
    return new AppError(409, 'unexpected-chunk-index', 'chunk_index is not the next expected index.', { expected_chunk_index: expected })
  }

  private isTerminal(lifecycle: Lifecycle): lifecycle is TerminalStatus {
    return lifecycle === 'completed' || lifecycle === 'failed' || lifecycle === 'timed-out'
  }

  async shutdown(): Promise<void> {
    this.accepting = false
    for (const initialization of this.initializing.values()) initialization.abort(new Error('server-shutdown'))
    await Promise.allSettled([...this.locks.values()])
    const sessions = [...this.active.values()]
    await Promise.all(sessions.map((session) => this.withKeyLock(session.key, () => this.failSession(session, 'server-shutdown'))))
    await Promise.allSettled(sessions.flatMap((session) => [session.pump, session.finalization].filter((p): p is Promise<void> => Boolean(p))))
    this.locks.clear()
    this.initializing.clear()
  }

  get activeSessionCount(): number { return this.active.size + this.initializing.size }
  get completedReceiptCount(): number { this.evictCompleted(); return this.completed.size }
}
