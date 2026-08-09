export function makeWav(options: {
  sampleRate?: number
  channels?: number
  bitsPerSample?: number
  samples?: number
  audioFormat?: number
  extensibleSize?: number
  pcm?: Buffer
  extraChunk?: boolean
} = {}): Buffer {
  const sampleRate = options.sampleRate ?? 16_000
  const channels = options.channels ?? 1
  const bits = options.bitsPerSample ?? 16
  const pcm = options.pcm ?? Buffer.alloc((options.samples ?? 32_000) * channels * bits / 8)
  const chunks: Buffer[] = []
  if (options.extraChunk) {
    const junk = Buffer.alloc(8 + 3 + 1)
    junk.write('JUNK', 0, 'ascii')
    junk.writeUInt32LE(3, 4)
    chunks.push(junk)
  }
  const audioFormat = options.audioFormat ?? 1
  const fmtBodySize = audioFormat === 0xfffe ? 40 : 16
  const fmt = Buffer.alloc(8 + fmtBodySize)
  fmt.write('fmt ', 0, 'ascii')
  fmt.writeUInt32LE(fmtBodySize, 4)
  fmt.writeUInt16LE(audioFormat, 8)
  fmt.writeUInt16LE(channels, 10)
  fmt.writeUInt32LE(sampleRate, 12)
  fmt.writeUInt32LE(sampleRate * channels * bits / 8, 16)
  fmt.writeUInt16LE(channels * bits / 8, 20)
  fmt.writeUInt16LE(bits, 22)
  if (audioFormat === 0xfffe) {
    fmt.writeUInt16LE(options.extensibleSize ?? 22, 24)
    fmt.writeUInt16LE(bits, 26)
    Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(fmt, 32)
  }
  chunks.push(fmt)
  const dataHeader = Buffer.alloc(8)
  dataHeader.write('data', 0, 'ascii')
  dataHeader.writeUInt32LE(pcm.length, 4)
  chunks.push(dataHeader, pcm)
  if (pcm.length % 2) chunks.push(Buffer.alloc(1))
  const body = Buffer.concat(chunks)
  const header = Buffer.alloc(12)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(body.length + 4, 4)
  header.write('WAVE', 8, 'ascii')
  return Buffer.concat([header, body])
}
