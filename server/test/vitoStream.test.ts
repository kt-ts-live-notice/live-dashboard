import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { VitoStream, type VitoSocket, type VitoStreamHandlers } from '../src/stt/vitoStream.js'

class FakeSocket extends EventEmitter implements VitoSocket {
  readyState = 0
  bufferedAmount = 0
  sent: (Buffer | string)[] = []
  sendError?: Error
  suppressSendCallback = false
  terminated = false

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  send(data: Buffer | string, callback: (error?: Error) => void): void {
    this.sent.push(data)
    if (!this.suppressSendCallback) queueMicrotask(() => callback(this.sendError))
  }

  close(): void { this.closeWith(1000) }

  closeWith(code: number): void {
    this.readyState = 3
    this.emit('close', code)
  }

  terminate(): void {
    this.terminated = true
    this.readyState = 3
  }
}

function setup(overrides: Partial<VitoStreamHandlers> = {}) {
  const socket = new FakeSocket()
  let url = ''
  let authorization = ''
  const handlers: VitoStreamHandlers = {
    onInterim: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onClose: vi.fn(), ...overrides,
  }
  const stream = new VitoStream(handlers, undefined, {
    accessToken: async () => 'access-token',
    createSocket: (createdUrl, options) => {
      url = createdUrl
      authorization = options.headers.Authorization
      return socket
    },
  })
  return { stream, socket, handlers, get url() { return url }, get authorization() { return authorization } }
}

async function connectOpen(subject: ReturnType<typeof setup>): Promise<void> {
  const connection = subject.stream.connect(16_000)
  await Promise.resolve()
  subject.socket.open()
  await connection
}

describe('VitoStream adapter', () => {
  it('connects with 16000/LINEAR16/ITN/default MEETING and bearer auth', async () => {
    const subject = setup()
    await connectOpen(subject)
    const query = new URL(subject.url).searchParams
    expect(query.get('sample_rate')).toBe('16000')
    expect(query.get('encoding')).toBe('LINEAR16')
    expect(query.get('use_itn')).toBe('true')
    expect(query.get('domain')).toBe('MEETING')
    expect(subject.authorization).toBe('Bearer access-token')
  })

  it('rejects audio while closed and propagates send callback errors', async () => {
    const subject = setup()
    await expect(subject.stream.sendAudio(Buffer.from('pcm'))).rejects.toThrow(/not open/)
    await connectOpen(subject)
    subject.socket.sendError = new Error('callback failed')
    await expect(subject.stream.sendAudio(Buffer.from('pcm'))).rejects.toThrow('callback failed')
  })

  it('bounds and cancels a send whose socket callback never returns', async () => {
    vi.useFakeTimers()
    try {
      const subject = setup()
      await connectOpen(subject)
      subject.socket.suppressSendCallback = true

      const controller = new AbortController()
      const cancelled = subject.stream.sendAudio(Buffer.from('pcm'), controller.signal)
      controller.abort(new Error('session stopped'))
      await expect(cancelled).rejects.toThrow('session stopped')

      const timedOut = subject.stream.sendAudio(Buffer.from('pcm'))
      const rejected = expect(timedOut).rejects.toThrow('send timeout')
      await vi.advanceTimersByTimeAsync(5_000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('sends EOS idempotently and resolves finish only after a clean close', async () => {
    const subject = setup()
    await connectOpen(subject)
    await Promise.all([subject.stream.end(), subject.stream.end()])
    expect(subject.socket.sent.filter((value) => value === 'EOS')).toHaveLength(1)
    const finished = subject.stream.finish()
    subject.socket.closeWith(1000)
    await expect(finished).resolves.toBeUndefined()
  })

  it('rejects finish and reports an abnormal close', async () => {
    const subject = setup()
    await connectOpen(subject)
    await subject.stream.end()
    const finished = subject.stream.finish()
    subject.socket.closeWith(1006)
    await expect(finished).rejects.toThrow(/abnormally/)
    expect(subject.handlers.onError).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('1006') }))
  })

  it('isolates throwing message callbacks from the socket event loop', async () => {
    const onError = vi.fn(() => { throw new Error('error callback also failed') })
    const subject = setup({ onFinal: () => { throw new Error('consumer failed') }, onError })
    await connectOpen(subject)
    expect(() => subject.socket.emit('message', Buffer.from(JSON.stringify({
      seq: 7, final: true, alternatives: [{ text: '안내' }],
    })))).not.toThrow()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'consumer failed' }))
  })

  it('cancels a socket that never opens', async () => {
    const subject = setup()
    const controller = new AbortController()
    const connection = subject.stream.connect(16_000, controller.signal)
    await Promise.resolve()
    controller.abort(new Error('connect timeout'))
    await expect(connection).rejects.toThrow('connect timeout')
    expect(subject.socket.terminated).toBe(true)
  })
})
