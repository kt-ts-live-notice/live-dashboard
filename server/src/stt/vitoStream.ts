import WebSocket from 'ws'

const AUTH_URL = 'https://openapi.vito.ai/v1/authenticate'
const STREAM_URL = 'wss://openapi.vito.ai/v1/transcribe:streaming'

interface TokenCache {
  token: string
  expireAt: number // epoch seconds
}

let tokenCache: TokenCache | null = null

export async function getAccessToken(): Promise<string> {
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
  })
  if (!res.ok) {
    throw new Error(`VITO 인증 실패: ${res.status} ${await res.text()}`)
  }
  const data = (await res.json()) as { access_token: string; expire_at: number }
  tokenCache = { token: data.access_token, expireAt: data.expire_at }
  return data.access_token
}

export interface VitoStreamHandlers {
  onInterim: (text: string) => void
  onFinal: (text: string, seq: number) => void
  onError: (err: Error) => void
  onClose: () => void
}

interface VitoResponse {
  seq: number
  final: boolean
  alternatives: { text: string; confidence?: number }[]
}

/** VITO 스트리밍 STT 세션. 오디오 청크를 보내고 interim/final 텍스트를 받는다. */
export class VitoStream {
  private ws: WebSocket | null = null

  constructor(private handlers: VitoStreamHandlers) {}

  async connect(sampleRate: number): Promise<void> {
    const token = await getAccessToken()
    const params = new URLSearchParams({
      sample_rate: String(sampleRate),
      encoding: 'LINEAR16',
      use_itn: 'true',
    })
    const ws = new WebSocket(`${STREAM_URL}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    this.ws = ws

    ws.on('message', (raw) => {
      let msg: VitoResponse
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      const text = msg.alternatives?.[0]?.text?.trim()
      if (!text) return
      if (msg.final) this.handlers.onFinal(text, msg.seq)
      else this.handlers.onInterim(text)
    })
    ws.on('error', (err) => this.handlers.onError(err as Error))
    ws.on('close', () => this.handlers.onClose())

    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
  }

  sendAudio(chunk: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(chunk)
  }

  /** 오디오 전송 종료를 알린다. 서버가 남은 결과를 보낸 뒤 연결을 닫는다. */
  end(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('EOS')
  }

  close(): void {
    this.ws?.close()
  }
}
