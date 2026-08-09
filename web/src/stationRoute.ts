export interface StationPageContext {
  id: string
  name: string
  previewAll: boolean
  showDeveloperTools: boolean
}

const STATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function resolveStationPage(pathname = location.pathname, search = location.search): StationPageContext | null {
  const match = pathname.match(/^\/stations\/([^/]+)\/([^/]+)\/?$/)
  if (!match) return null
  const id = decodeSegment(match[1])
  const rawName = decodeSegment(match[2])?.trim().replace(/\s+/g, ' ')
  if (!id || !STATION_ID_PATTERN.test(id) || !rawName || rawName.length > 30 || /[\u0000-\u001f]/.test(rawName)) return null
  const params = new URLSearchParams(search)
  const previewAll = params.get('preview') === 'all'
  return {
    id,
    name: rawName.endsWith('역') ? rawName : `${rawName}역`,
    previewAll,
    showDeveloperTools: previewAll || params.get('dev') === '1',
  }
}
