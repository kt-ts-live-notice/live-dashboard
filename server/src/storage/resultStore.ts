import type { Classification } from '../pipeline/classify.js'

export interface SessionResult {
  deviceId: string
  sessionId: string
  firstRecordedAt: string
  finalRecordedAt: string
  firstReceivedAt: number
  finalReceivedAt: number
  transcript: string
  classification: Classification
  outcome: 'filtered' | 'announcement'
  completedAt: number
}

export interface ResultStore {
  putIfAbsent(sessionKey: string, result: SessionResult): Promise<boolean>
  get?(sessionKey: string): SessionResult | undefined
}

export class InMemoryResultStore implements ResultStore {
  private readonly results = new Map<string, SessionResult>()

  async putIfAbsent(sessionKey: string, result: SessionResult): Promise<boolean> {
    if (this.results.has(sessionKey)) return false
    this.results.set(sessionKey, structuredClone(result))
    return true
  }

  get(sessionKey: string): SessionResult | undefined {
    const value = this.results.get(sessionKey)
    return value && structuredClone(value)
  }
}
