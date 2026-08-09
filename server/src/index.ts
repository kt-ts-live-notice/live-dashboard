import './env.js'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, WebSocket } from 'ws'
import { VitoStream } from './stt/vitoStream.js'
import { playWavRealtime, parseWav } from './audio/filePlayer.js'
import { classify } from './pipeline/classify.js'
import { loadConfig } from './config.js'
import { DeviceAuthenticator } from './http/deviceAuth.js'
import { AudioChunkSessionManager } from './sessions/audioChunkSessionManager.js'
import { InMemoryResultStore } from './storage/resultStore.js'
import { createApp, type SampleController } from './app.js'
import { parseStationSubscription, shouldDeliverToStation } from './ws/stationSubscription.js'

const config = loadConfig()
const SAMPLES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../samples')
const wss = new WebSocketServer({ noServer: true })
const stationSubscriptions = new WeakMap<WebSocket, string | null>()

function broadcast(event: Record<string, unknown>): void {
  const message = JSON.stringify(event)
  for (const client of wss.clients) {
    const stationId = stationSubscriptions.get(client) ?? null
    if (client.readyState === WebSocket.OPEN && shouldDeliverToStation(event, stationId)) client.send(message)
  }
}

let playing: string | null = null
let announcementSeq = 0

async function runSamplePipeline(sampleName: string, stationId?: string): Promise<void> {
  const filePath = join(SAMPLES_DIR, `${sampleName}.wav`)
  const { sampleRate } = parseWav(await readFile(filePath))
  const stationIdentity = stationId ? { device_id: stationId } : {}
  broadcast({ type: 'status', playing, ...stationIdentity })
  console.log(`[play] ${sampleName} (${sampleRate}Hz)`)
  const finalSegments = new Map<number, string>()
  const stt = new VitoStream({
    onInterim: (text) => broadcast({ type: 'stt-interim', text, ts: Date.now(), ...stationIdentity }),
    onFinal: (text, seq) => {
      console.log(`[stt-final #${seq}] ${text}`)
      finalSegments.set(seq, text)
      broadcast({ type: 'stt-final', text, seq, ts: Date.now(), ...stationIdentity })
    },
    onError: (error) => console.error('[stt error]', error.message),
    onClose: () => undefined,
  }, config.vitoDomain)
  try {
    await stt.connect(sampleRate)
    await playWavRealtime(filePath, (chunk) => stt.sendAudio(chunk))
    await stt.end()
    await Promise.race([
      stt.finish(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('VITO final result timeout')), config.vitoFinalWaitMs)),
    ])
    const transcript = [...finalSegments.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join(' ')
      .trim()
    if (!transcript) return
    const finalAt = Date.now()
    const result = await classify(transcript)
    const latencyMs = Date.now() - finalAt
    if (!result.is_announcement) {
      broadcast({ type: 'filtered', text: transcript, ts: Date.now(), ...stationIdentity })
      return
    }
    broadcast({
      type: 'announcement', id: ++announcementSeq, original: transcript, simplified: result.simplified,
      category: result.category, label: result.label, severity: result.severity, display: result.display,
      latencyMs, ts: Date.now(), ...stationIdentity,
    })
  } finally {
    stt.close()
    playing = null
    broadcast({ type: 'status', playing: null, ...stationIdentity })
    console.log(`[done] ${sampleName}`)
  }
}

const samples: SampleController = {
  async list() {
    const files = await readdir(SAMPLES_DIR).catch((): string[] => [])
    return files.filter((file) => file.endsWith('.wav')).map((file) => file.replace(/\.wav$/, ''))
  },
  async read(name) {
    return readFile(join(SAMPLES_DIR, `${name}.wav`)).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
      throw error
    })
  },
  current: () => playing,
  play(name, stationId) {
    if (playing) return false
    playing = name
    void runSamplePipeline(name, stationId).catch((error) => {
      console.error('[pipeline error]', error)
      playing = null
      broadcast({ type: 'status', playing: null, error: error instanceof Error ? error.message : String(error) })
    })
    return true
  },
}

const resultStore = new InMemoryResultStore()
const sessions = new AudioChunkSessionManager({
  maxActiveSessions: config.maxActiveSessions,
  inactivityMs: config.sessionInactivityMs,
  completedTtlMs: config.finalizedReceiptTtlMs,
  queueMaxMs: config.sessionQueueMaxMs,
  maxSessionChunks: config.maxSessionChunks,
  maxCompletedReceipts: config.maxCompletedReceipts,
  frameMs: config.vitoFrameMs,
  connectTimeoutMs: config.vitoConnectTimeoutMs,
  finalWaitMs: config.vitoFinalWaitMs,
  classifyTimeoutMs: config.classifyTimeoutMs,
}, {
  streamFactory: {
    async create(handlers, signal) {
      const stream = new VitoStream(handlers, config.vitoDomain)
      await stream.connect(16_000, signal)
      return stream
    },
  },
  classifier: (text, context) => classify(text, context),
  resultStore,
  broadcast,
})

const app = createApp({
  authenticator: new DeviceAuthenticator(config.deviceTokens, config.deviceAuthConfigured),
  sessionManager: sessions,
  requireHttps: config.requireHttps,
  samples,
})
const server = createServer(app)
server.requestTimeout = config.requestTimeoutMs
server.headersTimeout = config.headersTimeoutMs
server.keepAliveTimeout = config.keepAliveTimeoutMs
server.on('upgrade', (req, socket, head) => {
  const subscription = parseStationSubscription(req.url)
  if (!subscription) {
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    stationSubscriptions.set(ws, subscription.stationId)
    wss.emit('connection', ws, req)
  })
})

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  await sessions.shutdown()
  for (const client of wss.clients) client.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)) })
process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)) })

server.listen(config.port, () => {
  console.log(`server: http://localhost:${config.port} (ws: /ws)`)
  const missing = ['RTZR_CLIENT_ID', 'RTZR_CLIENT_SECRET', 'ANTHROPIC_API_KEY'].filter((key) => !process.env[key])
  if (missing.length) console.warn(`⚠️  .env에 누락된 키: ${missing.join(', ')} — 파이프라인 실행 시 실패합니다`)
  if (!config.deviceAuthConfigured) console.warn('⚠️  DEVICE_AUTH_TOKENS 미설정 — 오디오 청크 엔드포인트는 503을 반환합니다')
})
