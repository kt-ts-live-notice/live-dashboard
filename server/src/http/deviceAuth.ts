import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { AppError } from './problem.js'

export interface DevicePrincipal { deviceId: string }

export class DeviceAuthenticator {
  constructor(private readonly tokens: ReadonlyMap<string, string>, private readonly configured = tokens.size > 0) {}

  authenticate(req: IncomingMessage): DevicePrincipal {
    if (!this.configured) throw new AppError(503, 'device-auth-unavailable', 'Device audio ingestion is not configured.')
    const header = req.headers.authorization
    if (!header || !/^Bearer [^\s]+$/.test(header)) throw new AppError(401, 'invalid-device-token', 'A valid bearer token is required.')
    const supplied = Buffer.from(header.slice(7))
    for (const [deviceId, expected] of this.tokens) {
      const expectedBytes = Buffer.from(expected)
      if (supplied.length === expectedBytes.length && timingSafeEqual(supplied, expectedBytes)) return { deviceId }
    }
    throw new AppError(401, 'invalid-device-token', 'A valid bearer token is required.')
  }

  assertDevice(principal: DevicePrincipal, claimedDeviceId: string): void {
    if (principal.deviceId !== claimedDeviceId) throw new AppError(401, 'device-mismatch', 'The authenticated device does not match device_id.')
  }
}
