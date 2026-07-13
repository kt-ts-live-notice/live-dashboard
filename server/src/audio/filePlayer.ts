import { readFile } from 'node:fs/promises'

export interface WavData {
  sampleRate: number
  channels: number
  bitsPerSample: number
  pcm: Buffer
}

/** RIFF 청크를 순회하며 fmt/data를 찾는다. 16bit PCM mono만 지원. */
export function parseWav(buf: Buffer): WavData {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAV 파일이 아닙니다')
  }
  let fmt: { sampleRate: number; channels: number; bitsPerSample: number; audioFormat: number } | null = null
  let pcm: Buffer | null = null
  let offset = 12
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4)
    const chunkSize = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      }
    } else if (chunkId === 'data') {
      pcm = buf.subarray(body, Math.min(body + chunkSize, buf.length))
    }
    offset = body + chunkSize + (chunkSize % 2)
  }
  if (!fmt || !pcm) throw new Error('fmt/data 청크를 찾지 못했습니다')
  // 1=PCM, 65534=WAVE_FORMAT_EXTENSIBLE (afconvert 출력 등 — 16bit 정수면 PCM으로 취급)
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 0xfffe) {
    throw new Error(`PCM이 아닌 포맷입니다 (audioFormat=${fmt.audioFormat})`)
  }
  if (fmt.bitsPerSample !== 16) throw new Error(`16bit만 지원합니다 (${fmt.bitsPerSample}bit)`)
  if (fmt.channels !== 1) throw new Error(`mono만 지원합니다 (${fmt.channels}ch)`)
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bitsPerSample, pcm }
}

/** PCM을 chunkMs 단위로 나눠 실제 재생 속도에 맞춰 send에 전달한다. */
export async function playWavRealtime(
  filePath: string,
  send: (chunk: Buffer) => void,
  opts: { chunkMs?: number; signal?: AbortSignal } = {},
): Promise<{ sampleRate: number; durationMs: number }> {
  const chunkMs = opts.chunkMs ?? 100
  const { sampleRate, pcm } = parseWav(await readFile(filePath))
  const bytesPerChunk = Math.floor((sampleRate * 2 * chunkMs) / 1000)
  const durationMs = (pcm.length / (sampleRate * 2)) * 1000

  const start = Date.now()
  for (let i = 0, n = 0; i < pcm.length; i += bytesPerChunk, n++) {
    if (opts.signal?.aborted) break
    send(pcm.subarray(i, Math.min(i + bytesPerChunk, pcm.length)))
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
