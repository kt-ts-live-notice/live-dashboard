export interface AppConfig {
  port: number
  deviceTokens: ReadonlyMap<string, string>
  deviceAuthConfigured: boolean
  maxActiveSessions: number
  sessionInactivityMs: number
  finalizedReceiptTtlMs: number
  sessionQueueMaxMs: number
  maxSessionChunks: number
  maxCompletedReceipts: number
  vitoFrameMs: number
  vitoDomain: string
  vitoConnectTimeoutMs: number
  vitoFinalWaitMs: number
  classifyTimeoutMs: number
  requestTimeoutMs: number
  headersTimeoutMs: number
  keepAliveTimeoutMs: number
  requireHttps: boolean
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = env[name]
  const value = raw === undefined || raw === '' ? fallback : Number(raw)
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}`)
  return value
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new Error(`${name} must be true or false`)
}

function parseDeviceTokens(raw: string | undefined): { tokens: Map<string, string>; configured: boolean } {
  if (!raw) return { tokens: new Map(), configured: false }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('DEVICE_AUTH_TOKENS must be a JSON object')
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('DEVICE_AUTH_TOKENS must be a JSON object')
  const tokens = new Map<string, string>()
  const seen = new Set<string>()
  for (const [deviceId, token] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(deviceId) || typeof token !== 'string' || token.length < 1 || token.length > 512) {
      throw new Error('DEVICE_AUTH_TOKENS contains an invalid device id or token')
    }
    if (seen.has(token)) throw new Error('DEVICE_AUTH_TOKENS bearer tokens must be unique')
    seen.add(token)
    tokens.set(deviceId, token)
  }
  return { tokens, configured: tokens.size > 0 }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const auth = parseDeviceTokens(env.DEVICE_AUTH_TOKENS)
  const requestTimeoutMs = integer(env, 'REQUEST_TIMEOUT_MS', 10_000, 100, 300_000)
  const headersTimeoutMs = integer(env, 'HEADERS_TIMEOUT_MS', 5_000, 100, requestTimeoutMs)
  const vitoFrameMs = integer(env, 'VITO_FRAME_MS', 100, 50, 100)
  const vitoDomain = env.VITO_DOMAIN?.trim() || 'MEETING'
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(vitoDomain)) throw new Error('VITO_DOMAIN contains invalid characters')
  return {
    port: integer(env, 'PORT', 8787, 1, 65_535),
    deviceTokens: auth.tokens,
    deviceAuthConfigured: auth.configured,
    maxActiveSessions: integer(env, 'MAX_ACTIVE_SESSIONS', 8, 1, 10_000),
    sessionInactivityMs: integer(env, 'SESSION_INACTIVITY_MS', 15_000, 100, 3_600_000),
    finalizedReceiptTtlMs: integer(env, 'FINALIZED_RECEIPT_TTL_MS', 60_000, 100, 86_400_000),
    sessionQueueMaxMs: integer(env, 'SESSION_QUEUE_MAX_MS', 8_000, 100, 60_000),
    maxSessionChunks: integer(env, 'MAX_SESSION_CHUNKS', 1_800, 1, 100_000),
    maxCompletedReceipts: integer(env, 'MAX_COMPLETED_RECEIPTS', 1_024, 1, 100_000),
    vitoFrameMs,
    vitoDomain,
    vitoConnectTimeoutMs: integer(env, 'VITO_CONNECT_TIMEOUT_MS', 10_000, 100, 120_000),
    vitoFinalWaitMs: integer(env, 'VITO_FINAL_WAIT_MS', 10_000, 100, 120_000),
    classifyTimeoutMs: integer(env, 'CLASSIFY_TIMEOUT_MS', 15_000, 100, 120_000),
    requestTimeoutMs,
    headersTimeoutMs,
    keepAliveTimeoutMs: integer(env, 'KEEP_ALIVE_TIMEOUT_MS', 5_000, 100, 300_000),
    requireHttps: boolean(env, 'REQUIRE_HTTPS', false),
  }
}
