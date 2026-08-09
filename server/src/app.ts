import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { createAudioChunkHandler, type AudioChunkHandlerOptions } from './http/audioChunkHandler.js'
import { AppError, writeProblem } from './http/problem.js'
import { isValidStationId } from './ws/stationSubscription.js'

export interface SampleController {
  list(): Promise<string[]>
  read(name: string): Promise<Buffer | null>
  current(): string | null
  play(name: string, stationId?: string): boolean
}

export interface AppDependencies extends AudioChunkHandlerOptions {
  samples: SampleController
}

export function createApp(dependencies: AppDependencies): RequestListener {
  const chunks = createAudioChunkHandler(dependencies)
  return (req: IncomingMessage, res: ServerResponse) => {
    void route(req, res).catch((error) => writeProblem(res, error, req.url ?? '/'))
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.method === 'POST' && url.pathname === '/api/v1/audio-chunks') return chunks(req, res)
    if (req.method === 'GET' && url.pathname === '/api/samples') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ samples: await dependencies.samples.list(), playing: dependencies.samples.current() }))
      return
    }
    const sampleAudioMatch = url.pathname.match(/^\/api\/samples\/([\w-]+)\/audio$/)
    if ((req.method === 'GET' || req.method === 'HEAD') && sampleAudioMatch) {
      const audio = await dependencies.samples.read(sampleAudioMatch[1])
      if (!audio) throw new AppError(404, 'sample-not-found', 'The requested sample audio was not found.')
      res.setHeader('Content-Type', 'audio/wav')
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Accept-Ranges', 'bytes')
      const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
      if (req.headers.range && !range) {
        res.statusCode = 416
        res.setHeader('Content-Range', `bytes */${audio.length}`)
        res.end()
        return
      }
      let start = 0
      let end = audio.length - 1
      if (range) {
        if (!range[1] && !range[2]) {
          res.statusCode = 416
          res.setHeader('Content-Range', `bytes */${audio.length}`)
          res.end()
          return
        }
        if (!range[1]) start = Math.max(0, audio.length - Number(range[2]))
        else start = Number(range[1])
        if (range[2] && range[1]) end = Math.min(end, Number(range[2]))
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= audio.length) {
          res.statusCode = 416
          res.setHeader('Content-Range', `bytes */${audio.length}`)
          res.end()
          return
        }
        res.statusCode = 206
        res.setHeader('Content-Range', `bytes ${start}-${end}/${audio.length}`)
      }
      const body = audio.subarray(start, end + 1)
      res.setHeader('Content-Length', String(body.length))
      res.end(req.method === 'HEAD' ? undefined : body)
      return
    }
    const playMatch = url.pathname.match(/^\/api\/play\/([\w-]+)$/)
    if (req.method === 'POST' && playMatch) {
      const stationId = url.searchParams.get('station_id') ?? undefined
      if (stationId !== undefined && !isValidStationId(stationId)) throw new AppError(400, 'invalid-station-id', 'station_id is invalid.')
      if (!dependencies.samples.play(playMatch[1], stationId)) {
        res.statusCode = 409
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: `이미 재생 중: ${dependencies.samples.current()}` }))
        return
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ ok: true, playing: playMatch[1] }))
      return
    }
    throw new AppError(404, 'not-found', 'The requested resource was not found.')
  }
}
