import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { createAudioChunkHandler, type AudioChunkHandlerOptions } from './http/audioChunkHandler.js'
import { AppError, writeProblem } from './http/problem.js'
import { isValidStationId } from './ws/stationSubscription.js'

export interface SampleController {
  list(): Promise<string[]>
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
