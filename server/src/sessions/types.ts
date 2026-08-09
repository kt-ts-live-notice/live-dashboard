import type { Classification } from '../pipeline/classify.js'

export interface StreamHandlers {
  onInterim(text: string, seq?: number): void
  onFinal(text: string, seq: number): void
  onError(error: Error): void
  onClose(): void
}

export interface AudioStream {
  sendAudio(chunk: Buffer, signal?: AbortSignal): Promise<void>
  end(signal?: AbortSignal): Promise<void>
  finish(): Promise<void>
  close(): void
}

export interface StreamFactory {
  create(handlers: StreamHandlers, signal?: AbortSignal): Promise<AudioStream>
}

export interface AudioChunkInput {
  deviceId: string
  sessionId: string
  chunkIndex: number
  isFinal: boolean
  recordedAt: string
  receivedAt: number
  rawWav: Buffer
  pcm: Buffer
}

export interface ChunkAcknowledgement {
  session_id: string
  accepted_chunk_index: number
  next_chunk_index: number
  is_duplicate: boolean
  finalized: boolean
}

export type BroadcastEvent = Record<string, unknown> & { type: string }
export type Broadcaster = (event: BroadcastEvent) => void | Promise<void>
export type Classifier = (text: string, context: string[], signal?: AbortSignal) => Promise<Classification>

export interface SessionManagerOptions {
  maxActiveSessions: number
  inactivityMs: number
  completedTtlMs: number
  queueMaxMs: number
  maxSessionChunks: number
  maxCompletedReceipts: number
  frameMs: number
  connectTimeoutMs: number
  finalWaitMs: number
  classifyTimeoutMs: number
}
