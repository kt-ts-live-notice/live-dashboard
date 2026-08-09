import { describe, expect, it } from 'vitest'
import { parseUploadWav, parseWav } from '../src/audio/filePlayer.js'
import { makeWav } from './helpers/wav.js'

describe('hardened WAV upload parsing', () => {
  it('accepts exact normal and shorter final PCM', () => {
    expect(parseUploadWav(makeWav(), false).pcm).toHaveLength(64_000)
    expect(parseUploadWav(makeWav({ samples: 8_000, extraChunk: true }), true).pcm).toHaveLength(16_000)
    expect(parseUploadWav(makeWav({ samples: 8_000, audioFormat: 0xfffe }), true).pcm).toHaveLength(16_000)
  })

  const invalidUploads: Array<[string, Buffer, boolean]> = [
    ['wrong rate', makeWav({ sampleRate: 8_000 }), false],
    ['wrong channels', makeWav({ channels: 2 }), false],
    ['wrong bits', makeWav({ bitsPerSample: 8 }), false],
    ['non PCM', makeWav({ audioFormat: 3 }), false],
    ['short non-final', makeWav({ samples: 1_000 }), false],
    ['long final', makeWav({ samples: 32_001 }), true],
    ['empty final', makeWav({ samples: 0, pcm: Buffer.alloc(0) }), true],
    ['odd PCM', makeWav({ pcm: Buffer.alloc(3) }), true],
    ['truncated extensible fmt', makeWav({ samples: 8_000, audioFormat: 0xfffe, extensibleSize: 23 }), true],
  ]

  it.each(invalidUploads)('rejects %s', (_name, wav, final) => expect(() => parseUploadWav(wav, final)).toThrow())

  it('rejects truncated and lying RIFF/chunk declarations', () => {
    const wav = makeWav()
    expect(() => parseWav(wav.subarray(0, -1))).toThrow(/RIFF/)
    const lying = Buffer.from(wav)
    lying.writeUInt32LE(0xfffffff0, 40)
    expect(() => parseWav(lying)).toThrow(/data/)
    const shortFmt = Buffer.from(wav)
    shortFmt.writeUInt32LE(10, 16)
    expect(() => parseWav(shortFmt)).toThrow()
  })
})
