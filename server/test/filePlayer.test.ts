import { describe, it, expect } from 'vitest'
import { parseWav } from '../src/audio/filePlayer.js'

/** 16bit mono PCM WAV 버퍼 생성 (extraChunk로 fmt 앞 임의 청크 삽입 가능) */
function makeWav(sampleRate: number, samples: number, extraChunk = false): Buffer {
  const pcm = Buffer.alloc(samples * 2)
  const chunks: Buffer[] = []

  if (extraChunk) {
    const junk = Buffer.alloc(8 + 10)
    junk.write('JUNK', 0, 'ascii')
    junk.writeUInt32LE(10, 4)
    chunks.push(junk)
  }

  const fmt = Buffer.alloc(8 + 16)
  fmt.write('fmt ', 0, 'ascii')
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8) // PCM
  fmt.writeUInt16LE(1, 10) // mono
  fmt.writeUInt32LE(sampleRate, 12)
  fmt.writeUInt32LE(sampleRate * 2, 16)
  fmt.writeUInt16LE(2, 20)
  fmt.writeUInt16LE(16, 22)
  chunks.push(fmt)

  const data = Buffer.alloc(8)
  data.write('data', 0, 'ascii')
  data.writeUInt32LE(pcm.length, 4)
  chunks.push(data, pcm)

  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(4 + body.length, 4)
  header.write('WAVE', 8, 'ascii')
  return Buffer.concat([header, body])
}

describe('parseWav', () => {
  it('16k mono WAV를 파싱한다', () => {
    const wav = makeWav(16000, 1600)
    const parsed = parseWav(wav)
    expect(parsed.sampleRate).toBe(16000)
    expect(parsed.channels).toBe(1)
    expect(parsed.bitsPerSample).toBe(16)
    expect(parsed.pcm.length).toBe(3200)
  })

  it('fmt 앞에 다른 청크가 있어도 파싱한다', () => {
    const wav = makeWav(16000, 800, true)
    expect(parseWav(wav).pcm.length).toBe(1600)
  })

  it('WAV가 아니면 에러', () => {
    expect(() => parseWav(Buffer.from('hello world, not a wav'))).toThrow('WAV 파일이 아닙니다')
  })

  it('스테레오는 거부한다', () => {
    const wav = makeWav(16000, 100)
    wav.writeUInt16LE(2, 22) // channels 위치 (12 + 8 + 2)
    expect(() => parseWav(wav)).toThrow('mono만 지원')
  })
})
