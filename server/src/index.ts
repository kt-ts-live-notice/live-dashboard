import './env.js'
import { createServer } from 'node:http'
import { readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { VitoStream } from './stt/vitoStream.js'
import { playWavRealtime, parseWav } from './audio/filePlayer.js'
import { readFile } from 'node:fs/promises'
import { classify } from './pipeline/classify.js'

const PORT = Number(process.env.PORT ?? 8787)
const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../samples')

// --- WebSocket 브로드캐스트 ---

const wss = new WebSocketServer({ noServer: true })

function broadcast(event: Record<string, unknown>): void {
  const msg = JSON.stringify(event)
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg)
  }
}

// --- 파이프라인 ---

let playing: string | null = null
let announcementSeq = 0
const recentUtterances: string[] = []

async function runPipeline(sampleName: string): Promise<void> {
  const filePath = join(SAMPLES_DIR, `${sampleName}.wav`)
  const { sampleRate } = parseWav(await readFile(filePath))

  broadcast({ type: 'status', playing })
  console.log(`[play] ${sampleName} (${sampleRate}Hz)`)
  recentUtterances.length = 0 // 샘플은 독립 녹음이므로 이전 재생의 컨텍스트를 비움

  let sttDone: () => void
  const sttClosed = new Promise<void>((r) => (sttDone = r))
  const pendingClassify: Promise<void>[] = []

  const stt = new VitoStream({
    onInterim: (text) => {
      broadcast({ type: 'stt-interim', text, ts: Date.now() })
    },
    onFinal: (text, seq) => {
      const finalAt = Date.now()
      console.log(`[stt-final #${seq}] ${text}`)
      broadcast({ type: 'stt-final', text, seq, ts: finalAt })

      const context = [...recentUtterances]
      recentUtterances.push(text)
      if (recentUtterances.length > 2) recentUtterances.shift()

      const job = classify(text, context)
        .then((result) => {
          const latencyMs = Date.now() - finalAt
          console.log(`[classify +${latencyMs}ms]`, result)
          if (!result.is_announcement) {
            console.log(`[filtered] 안내방송 아님: "${text}"`)
            broadcast({ type: 'filtered', text, ts: Date.now() })
            return
          }
          broadcast({
            type: 'announcement',
            id: ++announcementSeq,
            original: text,
            simplified: result.simplified,
            category: result.category,
            severity: result.severity,
            latencyMs,
            ts: Date.now(),
          })
        })
        .catch((err) => console.error('[classify error]', err))
      pendingClassify.push(job)
    },
    onError: (err) => console.error('[stt error]', err.message),
    onClose: () => sttDone(),
  })

  try {
    await stt.connect(sampleRate)
    await playWavRealtime(filePath, (chunk) => stt.sendAudio(chunk))
    stt.end()
    // EOS 후 남은 final 결과 수신 대기 (최대 10초)
    await Promise.race([sttClosed, new Promise((r) => setTimeout(r, 10_000))])
    // 진행 중인 분류가 끝난 뒤에 종료를 선언 (마지막 안내 유실 방지)
    await Promise.allSettled(pendingClassify)
  } finally {
    stt.close()
    playing = null
    broadcast({ type: 'status', playing: null })
    console.log(`[done] ${sampleName}`)
  }
}

// --- HTTP 라우팅 ---

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`)
  res.setHeader('Access-Control-Allow-Origin', '*')

  if (req.method === 'GET' && url.pathname === '/api/samples') {
    const files = await readdir(SAMPLES_DIR).catch(() => [] as string[])
    const samples = files.filter((f) => f.endsWith('.wav')).map((f) => f.replace(/\.wav$/, ''))
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ samples, playing }))
    return
  }

  const playMatch = url.pathname.match(/^\/api\/play\/([\w-]+)$/)
  if (req.method === 'POST' && playMatch) {
    if (playing) {
      res.statusCode = 409
      res.end(JSON.stringify({ error: `이미 재생 중: ${playing}` }))
      return
    }
    const name = playMatch[1]
    // 핸들러에서 동기적으로 선점해 동시 POST 레이스 차단
    playing = name
    runPipeline(name).catch((err) => {
      console.error('[pipeline error]', err)
      playing = null
      broadcast({ type: 'status', playing: null, error: String(err.message ?? err) })
    })
    res.end(JSON.stringify({ ok: true, playing: name }))
    return
  }

  res.statusCode = 404
  res.end('not found')
})

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  } else {
    socket.destroy()
  }
})

server.listen(PORT, () => {
  console.log(`server: http://localhost:${PORT} (ws: /ws)`)
  const missing = ['RTZR_CLIENT_ID', 'RTZR_CLIENT_SECRET', 'ANTHROPIC_API_KEY'].filter((k) => !process.env[k])
  if (missing.length) console.warn(`⚠️  .env에 누락된 키: ${missing.join(', ')} — 파이프라인 실행 시 실패합니다`)
})
