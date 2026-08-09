import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { parseUploadWav } from '../audio/filePlayer.js'
import type { AudioChunkSessionManager } from '../sessions/audioChunkSessionManager.js'
import { parseAudioChunkMultipart } from './audioChunkMultipart.js'
import type { DeviceAuthenticator } from './deviceAuth.js'
import { AppError, writeProblem } from './problem.js'

export interface AudioChunkHandlerOptions {
  authenticator: DeviceAuthenticator
  sessionManager: AudioChunkSessionManager
  requireHttps?: boolean
  now?: () => number
}

export function createAudioChunkHandler(options: AudioChunkHandlerOptions) {
  const now = options.now ?? Date.now
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const receivedAt = now()
    const instance = `/api/v1/audio-chunks#${randomUUID()}`
    try {
      if (options.requireHttps && req.headers['x-forwarded-proto'] !== 'https') {
        throw new AppError(400, 'https-required', 'HTTPS is required for device uploads.')
      }
      const principal = options.authenticator.authenticate(req)
      const body = await parseAudioChunkMultipart(req)
      options.authenticator.assertDevice(principal, body.deviceId)
      let pcm: Buffer
      try {
        pcm = parseUploadWav(body.audio, body.isFinal).pcm
      } catch (error) {
        throw new AppError(422, 'invalid-wav', error instanceof Error ? error.message : 'The WAV file is invalid.')
      }
      const acknowledgement = await options.sessionManager.accept({
        deviceId: body.deviceId, sessionId: body.sessionId, chunkIndex: body.chunkIndex, isFinal: body.isFinal,
        recordedAt: body.recordedAt, receivedAt, rawWav: body.audio, pcm,
      })
      if (res.writableEnded) return
      res.statusCode = 202
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(acknowledgement))
    } catch (error) {
      writeProblem(res, error, instance)
    }
  }
}
