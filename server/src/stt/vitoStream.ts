import WebSocket from 'ws'

const AUTH_URL = 'https://openapi.vito.ai/v1/authenticate'
const STREAM_URL = 'wss://openapi.vito.ai/v1/transcribe:streaming'

interface TokenCache {
  token: string
  expireAt: number // epoch seconds
}

let tokenCache: TokenCache | null = null

export async function getAccessToken(signal?: AbortSignal): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (tokenCache && tokenCache.expireAt - 60 > now) return tokenCache.token

  const clientId = process.env.RTZR_CLIENT_ID
  const clientSecret = process.env.RTZR_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('RTZR_CLIENT_ID / RTZR_CLIENT_SECRET 환경변수가 필요합니다')
  }

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret }),
    signal,
  })
  if (!res.ok) {
    throw new Error(`VITO 인증 실패: ${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as { access_token: string; expire_at: number }
  tokenCache = { token: data.access_token, expireAt: data.expire_at }
  return data.access_token
}

export interface VitoStreamHandlers {
  onInterim: (text: string, seq?: number) => void
  onFinal: (text: string, seq: number) => void
  onError: (err: Error) => void
  onClose: () => void
}

interface VitoResponse {
  seq: number
  final: boolean
  alternatives: { text: string; confidence?: number }[]
}

export interface VitoSocket {
  readyState: number
  bufferedAmount: number
  on(event: 'message', listener: (raw: unknown) => void): this
  on(event: 'error', listener: (error: unknown) => void): this
  on(event: 'close', listener: (code: number) => void): this
  once(event: 'open', listener: () => void): this
  once(event: 'error', listener: (error: unknown) => void): this
  off(event: 'open', listener: () => void): this
  off(event: 'error', listener: (error: unknown) => void): this
  send(data: Buffer | string, callback: (error?: Error) => void): void
  close(): void
  terminate(): void
}

export interface VitoStreamDependencies {
  accessToken?: (signal?: AbortSignal) => Promise<string>
  createSocket?: (url: string, options: { headers: { Authorization: string } }) => VitoSocket
  now?: () => number
}

/** VITO 스트리밍 STT 세션. 오디오 청크를 보내고 interim/final 텍스트를 받는다. */
export class VitoStream {
  private ws: VitoSocket | null = null
  private eosSent = false
  private completion: Promise<void> | null = null
  private endPromise: Promise<void> | null = null
  private resolveCompletion: (() => void) | null = null
  private rejectCompletion: ((error: Error) => void) | null = null

  private readonly accessToken: (signal?: AbortSignal) => Promise<string>
  private readonly createSocket: NonNullable<VitoStreamDependencies['createSocket']>
  private readonly now: () => number

  constructor(
    private readonly handlers: VitoStreamHandlers,
    private readonly domain = 'MEETING',
    dependencies: VitoStreamDependencies = {},
  ) {
    this.accessToken = dependencies.accessToken ?? getAccessToken
    this.createSocket = dependencies.createSocket ?? ((url, options) => new WebSocket(url, options))
    this.now = dependencies.now ?? Date.now
  }

  async connect(sampleRate = 16_000, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason ?? new Error('VITO connection aborted')
    const token = await this.accessToken(signal)
    if (signal?.aborted) throw signal.reason ?? new Error('VITO connection aborted')
    const params = new URLSearchParams({
      sample_rate: String(sampleRate),
      encoding: 'LINEAR16',
      use_itn: 'true',
      domain: this.domain,
    })
    const ws = this.createSocket(`${STREAM_URL}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    this.ws = ws

    this.completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve
      this.rejectCompletion = reject
    })
    void this.completion.catch(() => undefined)

    ws.on('message', (raw: unknown) => {
      let msg: VitoResponse
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      const text = msg.alternatives?.[0]?.text?.trim()
      if (!text) return
      try {
        if (msg.final) this.handlers.onFinal(text, msg.seq)
        else this.handlers.onInterim(text, msg.seq)
      } catch (error) {
        this.reportError(error instanceof Error ? error : new Error(String(error)))
      }
    })
    ws.on('error', (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err))
      this.rejectCompletion?.(error)
      this.reportError(error)
    })
    ws.on('close', (code: number) => {
      try { this.handlers.onClose() } catch { /* callback isolation */ }
      if (this.eosSent && code === 1000) this.resolveCompletion?.()
      else {
        const error = new Error(`VITO socket closed abnormally (${code})`)
        this.rejectCompletion?.(error)
        this.reportError(error)
      }
    })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        ws.off('open', opened)
        ws.off('error', failed)
        signal?.removeEventListener('abort', aborted)
      }
      const opened = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const failed = (error: unknown) => {
        if (settled) return
        settled = true
        try { ws.terminate() } catch { /* failed connection cleanup */ }
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const aborted = () => {
        failed(signal?.reason ?? new Error('VITO connection aborted'))
      }
      ws.once('open', opened)
      ws.once('error', failed)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) aborted()
    })
  }

  async sendAudio(chunk: Buffer, signal?: AbortSignal): Promise<void> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('VITO socket is not open')
    if (this.eosSent) throw new Error('VITO EOS has already been sent')
    if (signal?.aborted) throw signal.reason ?? new Error('audio send aborted')
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', aborted)
      }
      const succeed = () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const aborted = () => fail(signal?.reason ?? new Error('audio send aborted'))
      const timer = setTimeout(() => fail(new Error('VITO socket send timeout')), 5_000)
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) {
        aborted()
        return
      }
      try {
        ws.send(chunk, (error) => error ? fail(error) : succeed())
      } catch (error) {
        fail(error)
      }
    })
    const highWatermark = 512 * 1024
    const deadline = this.now() + 5_000
    while (ws.bufferedAmount > highWatermark) {
      if (signal?.aborted) throw signal.reason ?? new Error('audio send aborted')
      if (ws.readyState !== WebSocket.OPEN) throw new Error('VITO socket closed during backpressure wait')
      if (this.now() >= deadline) throw new Error('VITO socket backpressure timeout')
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          reject(signal?.reason ?? new Error('audio send aborted'))
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, 10)
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted) onAbort()
      })
    }
  }

  /** 오디오 전송 종료를 알린다. 서버가 남은 결과를 보낸 뒤 연결을 닫는다. */
  async end(signal?: AbortSignal): Promise<void> {
    if (this.endPromise) return this.endPromise
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('VITO socket is not open for EOS')
    this.eosSent = true
    this.endPromise = new Promise<void>((resolve, reject) => {
      const cleanup = () => signal?.removeEventListener('abort', aborted)
      const aborted = () => {
        cleanup()
        reject(signal?.reason ?? new Error('VITO EOS aborted'))
      }
      signal?.addEventListener('abort', aborted, { once: true })
      if (signal?.aborted) {
        aborted()
        return
      }
      ws.send('EOS', (error) => {
        cleanup()
        if (error) reject(error)
        else resolve()
      })
    })
    return this.endPromise
  }

  finish(): Promise<void> {
    if (!this.eosSent || !this.completion) return Promise.reject(new Error('VITO EOS must be sent before finish'))
    return this.completion
  }

  close(): void {
    this.ws?.close()
  }

  private reportError(error: Error): void {
    try { this.handlers.onError(error) } catch { /* callback isolation */ }
  }
}
