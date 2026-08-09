import { readFile } from 'node:fs/promises'

export interface WavData {
  sampleRate: number
  channels: number
  bitsPerSample: number
  pcm: Buffer
}

function wavError(message: string): never {
  throw new Error(message)
}

/** RIFF 청크를 순회하며 fmt/data를 찾는다. 16bit integer PCM mono만 지원. */
export function parseWav(buf: Buffer): WavData {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAV 파일이 아닙니다')
  }
  const riffSize = buf.readUInt32LE(4)
  const riffEnd = riffSize + 8
  if (riffEnd !== buf.length || riffEnd < 12) wavError('잘린 WAV RIFF 선언입니다')

  let fmt: {
    sampleRate: number
    channels: number
    bitsPerSample: number
    audioFormat: number
    blockAlign: number
    byteRate: number
  } | null = null
  let pcm: Buffer | null = null
  let offset = 12
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) wavError('잘린 WAV 청크 헤더입니다')
    const chunkId = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    const chunkEnd = body + chunkSize
    if (chunkEnd < body || chunkEnd > riffEnd) wavError(`잘린 WAV ${chunkId} 청크입니다`)
    if (chunkId === 'fmt ') {
      if (fmt) wavError('중복 fmt 청크입니다')
      if (chunkSize < 16) wavError('잘린 WAV fmt 청크입니다')
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        byteRate: buf.readUInt32LE(body + 8),
        blockAlign: buf.readUInt16LE(body + 12),
        bitsPerSample: buf.readUInt16LE(body + 14),
      }
      if (fmt.audioFormat === 0xfffe) {
        if (chunkSize < 18) wavError('잘못된 extensible WAV fmt 청크입니다')
        const extensionSize = buf.readUInt16LE(body + 16)
        if (extensionSize < 22 || 18 + extensionSize > chunkSize) wavError('잘못된 extensible WAV fmt 청크입니다')
        const validBits = buf.readUInt16LE(body + 18)
        const pcmGuid = Buffer.from('0100000000001000800000aa00389b71', 'hex')
        if (validBits !== 16 || !buf.subarray(body + 24, body + 40).equals(pcmGuid)) {
          wavError('지원하지 않는 extensible WAV 포맷입니다')
        }
      }
    } else if (chunkId === 'data') {
      if (pcm) wavError('중복 data 청크입니다')
      pcm = buf.subarray(body, chunkEnd)
    }
    const paddedEnd = chunkEnd + (chunkSize % 2)
    if (paddedEnd > riffEnd) wavError(`잘린 WAV ${chunkId} 패딩입니다`)
    offset = paddedEnd
  }
  if (!fmt || !pcm) throw new Error('fmt/data 청크를 찾지 못했습니다')
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 0xfffe) {
    throw new Error(`PCM이 아닌 포맷입니다 (audioFormat=${fmt.audioFormat})`)
  }
  if (fmt.bitsPerSample !== 16) throw new Error(`16bit만 지원합니다 (${fmt.bitsPerSample}bit)`)
  if (fmt.channels !== 1) throw new Error(`mono만 지원합니다 (${fmt.channels}ch)`)
  if (fmt.sampleRate <= 0 || fmt.blockAlign !== 2 || fmt.byteRate !== fmt.sampleRate * 2) {
    wavError('WAV fmt 필드가 서로 일치하지 않습니다')
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, pcm }
}

export function parseUploadWav(buf: Buffer, isFinal: boolean): WavData {
  const wav = parseWav(buf)
  if (wav.sampleRate !== 16_000) throw new Error(`16000Hz만 지원합니다 (${wav.sampleRate}Hz)`)
  if (wav.pcm.length === 0) throw new Error('빈 PCM 오디오는 지원하지 않습니다')
  if (wav.pcm.length % 2 !== 0) throw new Error('PCM 길이는 16bit 샘플 경계와 일치해야 합니다')
  if (isFinal) {
    if (wav.pcm.length > 64_000) throw new Error('마지막 오디오는 2초 이하여야 합니다')
  } else if (wav.pcm.length !== 64_000) {
    throw new Error('일반 오디오는 정확히 2초여야 합니다')
  }
  return wav
}

/** PCM을 chunkMs 단위로 나눠 실제 재생 속도에 맞춰 send에 전달한다. */
export async function playWavRealtime(
  filePath: string,
  send: (chunk: Buffer) => void | Promise<void>,
  opts: { chunkMs?: number; signal?: AbortSignal } = {},
): Promise<{ sampleRate: number; durationMs: number }> {
  const chunkMs = opts.chunkMs ?? 100
  const { sampleRate, pcm } = parseWav(await readFile(filePath))
  const bytesPerChunk = Math.floor((sampleRate * 2 * chunkMs) / 1000)
  const durationMs = (pcm.length / (sampleRate * 2)) * 1000

  const start = Date.now()
  for (let i = 0, n = 0; i < pcm.length; i += bytesPerChunk, n++) {
    if (opts.signal?.aborted) break
    await send(pcm.subarray(i, Math.min(i + bytesPerChunk, pcm.length)))
    // 누적 기준으로 대기해 드리프트 없이 실시간 속도 유지
    const nextAt = start + (n + 1) * chunkMs
    const wait = nextAt - Date.now()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }
  return { sampleRate, durationMs }
}

export function wavSampleRate(buf: Buffer): number {
  return parseWav(buf).sampleRate
}
