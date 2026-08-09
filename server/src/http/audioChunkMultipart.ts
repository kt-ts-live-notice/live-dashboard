import type { IncomingMessage } from 'node:http'
import Busboy from 'busboy'
import { AppError } from './problem.js'

const MAX_FILE_BYTES = 128 * 1024
const MAX_TOTAL_BYTES = 160 * 1024
const REQUIRED = new Set(['session_id', 'chunk_index', 'is_final', 'device_id', 'recorded_at'])
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

function isUtcRfc3339(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/)
  if (!match) return false
  const [, year, month, day, hour, minute, second] = match.map(Number)
  if (second > 59) return false
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
}

export interface AudioChunkMultipart {
  audio: Buffer
  sessionId: string
  chunkIndex: number
  isFinal: boolean
  deviceId: string
  recordedAt: string
}

export async function parseAudioChunkMultipart(req: IncomingMessage): Promise<AudioChunkMultipart> {
  const contentType = req.headers['content-type']
  if (!contentType?.toLowerCase().startsWith('multipart/form-data;') || !/boundary\s*=\s*(?:"[^"]+"|[^;\s]+)/i.test(contentType)) {
    throw new AppError(415, 'multipart-required', 'Content-Type must be multipart/form-data with a boundary.')
  }

  return new Promise((resolve, reject) => {
    let parser: ReturnType<typeof Busboy>
    try {
      parser = Busboy({
        headers: req.headers,
        // busboy stops when the configured parts count is reached, so one extra
        // sentinel slot lets us observe and reject an actual seventh part.
        limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5, parts: 7, fieldNameSize: 64, fieldSize: 128 },
      })
    } catch {
      reject(new AppError(400, 'malformed-multipart', 'The multipart request is malformed.'))
      return
    }
    let settled = false
    let total = 0
    let fileCount = 0
    let partCount = 0
    let fileLimited = false
    let audio: Buffer | undefined
    const fileChunks: Buffer[] = []
    const fields = new Map<string, string>()

    const fail = (error: AppError) => {
      if (settled) return
      settled = true
      req.off('data', onData)
      req.unpipe(parser)
      parser.removeAllListeners()
      req.resume()
      reject(error)
    }
    const onData = (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_TOTAL_BYTES) fail(new AppError(413, 'request-too-large', 'The multipart request exceeds 160 KiB.'))
    }
    req.on('data', onData)
    req.once('aborted', () => fail(new AppError(400, 'request-aborted', 'The upload was interrupted.')))
    req.once('error', () => fail(new AppError(400, 'request-error', 'The upload could not be read.')))

    parser.on('file', (name, stream, info) => {
      partCount += 1
      if (partCount > 6) {
        stream.resume()
        fail(new AppError(413, 'too-many-parts', 'The multipart request contains too many parts.'))
        return
      }
      fileCount += 1
      if (name !== 'audio') {
        stream.resume()
        fail(new AppError(400, 'unknown-part', 'The only permitted file field is audio.'))
        return
      }
      if (!info.mimeType || !['audio/wav', 'audio/wave', 'audio/x-wav', 'application/octet-stream'].includes(info.mimeType)) {
        stream.resume()
        fail(new AppError(422, 'invalid-audio-part', 'The audio part must contain a WAV file.'))
        return
      }
      stream.on('limit', () => { fileLimited = true })
      stream.on('data', (chunk: Buffer) => fileChunks.push(chunk))
      stream.on('end', () => { audio = Buffer.concat(fileChunks) })
    })
    parser.on('field', (name, value, info) => {
      partCount += 1
      if (partCount > 6) return fail(new AppError(413, 'too-many-parts', 'The multipart request contains too many parts.'))
      if (!REQUIRED.has(name)) return fail(new AppError(400, 'unknown-field', `Unknown field: ${name}.`))
      if (fields.has(name)) return fail(new AppError(400, 'duplicate-field', `Duplicate field: ${name}.`))
      if (info.valueTruncated || info.nameTruncated) return fail(new AppError(413, 'field-too-large', 'A multipart field exceeds its limit.'))
      fields.set(name, value)
    })
    for (const event of ['filesLimit', 'fieldsLimit'] as const) {
      parser.on(event, () => fail(new AppError(413, 'too-many-parts', 'The multipart request contains too many parts.')))
    }
    parser.on('partsLimit', () => {
      if (partCount >= 7) fail(new AppError(413, 'too-many-parts', 'The multipart request contains too many parts.'))
    })
    parser.once('error', () => fail(new AppError(400, 'malformed-multipart', 'The multipart request is malformed.')))
    parser.once('close', () => {
      req.off('data', onData)
      if (settled) return
      if (fileLimited) return fail(new AppError(413, 'audio-too-large', 'The audio file exceeds 128 KiB.'))
      if (fileCount !== 1 || !audio) return fail(new AppError(400, 'missing-audio', 'Exactly one audio file is required.'))
      for (const name of REQUIRED) if (!fields.has(name)) return fail(new AppError(400, 'missing-field', `Missing field: ${name}.`))
      const sessionId = fields.get('session_id')!
      const deviceId = fields.get('device_id')!
      if (!ID_RE.test(sessionId) || !ID_RE.test(deviceId)) return fail(new AppError(400, 'invalid-id', 'device_id and session_id must use safe characters and be 1-128 characters.'))
      const indexRaw = fields.get('chunk_index')!
      if (!/^(0|[1-9]\d{0,9})$/.test(indexRaw)) return fail(new AppError(400, 'invalid-chunk-index', 'chunk_index must be a non-negative decimal integer.'))
      const chunkIndex = Number(indexRaw)
      if (!Number.isSafeInteger(chunkIndex)) return fail(new AppError(400, 'invalid-chunk-index', 'chunk_index is too large.'))
      const finalRaw = fields.get('is_final')!
      if (finalRaw !== 'true' && finalRaw !== 'false') return fail(new AppError(400, 'invalid-is-final', 'is_final must be true or false.'))
      const recordedAt = fields.get('recorded_at')!
      if (recordedAt.length > 64 || !isUtcRfc3339(recordedAt)) {
        return fail(new AppError(400, 'invalid-recorded-at', 'recorded_at must be a real RFC3339 UTC timestamp ending in Z.'))
      }
      settled = true
      resolve({ audio, sessionId, chunkIndex, isFinal: finalRaw === 'true', deviceId, recordedAt })
    })
    req.pipe(parser)
  })
}
