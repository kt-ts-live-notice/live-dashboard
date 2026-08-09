export interface StationPageContext {
  id: string
  name: string
  mode: 'service' | 'demo'
}

const STATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function resolveStationPage(pathname = location.pathname): StationPageContext | null {
  const match = pathname.match(/^\/(stations|demo)\/([^/]+)\/([^/]+)\/?$/)
  if (!match) return null
  const id = decodeSegment(match[2])
  const rawName = decodeSegment(match[3])?.trim().replace(/\s+/g, ' ')
  if (!id || !STATION_ID_PATTERN.test(id) || !rawName || rawName.length > 30 || /[\u0000-\u001f]/.test(rawName)) return null
  return {
    id,
    name: rawName.endsWith('역') ? rawName : `${rawName}역`,
    mode: match[1] === 'demo' ? 'demo' : 'service',
  }
}
