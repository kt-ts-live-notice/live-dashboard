import type { ServerResponse } from 'node:http'

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extensions: Record<string, unknown> = {},
    public readonly headers: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'AppError'
  }
}

const TITLES: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 404: 'Not Found', 409: 'Conflict', 413: 'Content Too Large',
  415: 'Unsupported Media Type', 422: 'Unprocessable Content', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
}

export function writeProblem(res: ServerResponse, error: unknown, instance: string): void {
  const safe = error instanceof AppError ? error : new AppError(500, 'internal-error', 'The request could not be completed.')
  if (res.headersSent || res.writableEnded) return
  res.statusCode = safe.status
  res.setHeader('Content-Type', 'application/problem+json')
  for (const [name, value] of Object.entries(safe.headers)) res.setHeader(name, value)
  res.end(JSON.stringify({
    type: `urn:kt-ts:problem:${safe.code}`,
    title: TITLES[safe.status] ?? 'Error',
    status: safe.status,
    detail: safe.message,
    instance,
    ...safe.extensions,
  }))
}
